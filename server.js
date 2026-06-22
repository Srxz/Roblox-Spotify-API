import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import sharp from "sharp";
import * as tf from "@tensorflow/tfjs-node";
import * as nsfwjs from "nsfwjs";

dotenv.config();
const app = express();
app.use(cors());

// ---------- NSFW model ----------
// Loaded once at startup and kept warm in memory so requests don't pay
// the load cost. First request after a cold start (Render free tier
// spin-down) may still be slow since the model can't be warm yet.
let nsfwModel = null;
let nsfwModelLoading = null;

async function getNsfwModel() {
    if (nsfwModel) return nsfwModel;

    if (!nsfwModelLoading) {
        nsfwModelLoading = nsfwjs.load(
            "file://./mobilenet_v2/"
        ).then(model => {
            nsfwModel = model;
            return model;
        });
    }

    return nsfwModelLoading;
}

const NSFW_THRESHOLDS = {
    Porn: 0.6,
    Hentai: 0.6,
    Sexy: 0.75
};

async function isImageSafe(buffer) {
    const model = await getNsfwModel();
    const imageTensor = tf.node.decodeImage(buffer, 3);
    try {
        const predictions = await model.classify(imageTensor);
        const flagged = predictions.find(p => {
            const threshold = NSFW_THRESHOLDS[p.className];
            return threshold !== undefined && p.probability >= threshold;
        });
        return { safe: !flagged, predictions, flagged };
    } finally {
        imageTensor.dispose();
    }
}

// ---------- Spotify token ----------
let tokenCache = null;
let tokenExpire = 0;
async function getToken() {
    const now = Date.now();
    if (tokenCache && now < tokenExpire) return tokenCache;
    const auth = Buffer.from(
        `${process.env.CLIENT_ID}:${process.env.CLIENT_SECRET}`
    ).toString("base64");
    const res = await axios.post(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({ grant_type: "client_credentials" }),
        {
            headers: {
                Authorization: `Basic ${auth}`,
                "Content-Type": "application/x-www-form-urlencoded",
            },
        }
    );
    tokenCache = res.data.access_token;
    tokenExpire = now + res.data.expires_in * 1000;
    return tokenCache;
}

// ---------- SEARCH ----------
// GET /search?q=...&type=album|track|artist  (defaults to album)
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        const type = ["track", "artist"].includes(req.query.type)
            ? req.query.type
            : "album";

        const token = await getToken();
        const response = await axios.get(
            "https://api.spotify.com/v1/search",
            {
                headers: { Authorization: `Bearer ${token}` },
                params: { q, type, limit: 10 },
            }
        );

        if (type === "track") {
            const tracks = response.data.tracks.items.map(t => ({
                id: t.id,
                type: "track",
                name: t.name,
                artist: t.artists.map(x => x.name).join(", "),
                album: t.album?.name,
                image: t.album?.images?.[0]?.url,
                explicit: t.explicit,
            }));
            return res.json(tracks);
        }

        if (type === "artist") {
            const artists = response.data.artists.items.map(a => ({
                id: a.id,
                type: "artist",
                name: a.name,
                artist: a.name,
                image: a.images?.[0]?.url,
            }));
            return res.json(artists);
        }

        const albums = response.data.albums.items.map(a => ({
            id: a.id,
            type: "album",
            name: a.name,
            artist: a.artists.map(x => x.name).join(", "),
            image: a.images?.[0]?.url
        }));
        res.json(albums);
    } catch (err) {
        console.log(err.response?.data || err.message);
        res.status(500).json({ error: "search failed" });
    }
});

// ---------- COLOR QUANTIZATION ----------
// Reduces an RGB pixel list down to at most `maxColors` representative
// colors using a median-cut style approach: repeatedly split the
// largest-range bucket of pixels along its widest channel until we
// have enough buckets, then average each bucket into one final color.
// This keeps visually-similar colors grouped together instead of
// naively picking the N most frequent exact RGB values (which tends
// to produce near-duplicate colors from antialiasing/gradients).
function quantizeColors(pixels, maxColors) {
    if (pixels.length === 0) return { palette: [], quantizedPixels: [] };

    // Each bucket holds indices into `pixels`.
    let buckets = [pixels.map((_, i) => i)];

    function channelRange(indices, channel) {
        let min = 255, max = 0;
        for (const i of indices) {
            const v = pixels[i][channel];
            if (v < min) min = v;
            if (v > max) max = v;
        }
        return max - min;
    }

    function widestChannel(indices) {
        const ranges = [0, 1, 2].map(c => channelRange(indices, c));
        return ranges.indexOf(Math.max(...ranges));
    }

    while (buckets.length < maxColors) {
        // Pick the bucket with the largest range on its widest channel
        // to split next (biggest visual variance gets divided first).
        let bestIdx = -1, bestRange = -1, bestChannel = 0;
        buckets.forEach((bucket, idx) => {
            if (bucket.length < 2) return;
            const channel = widestChannel(bucket);
            const range = channelRange(bucket, channel);
            if (range > bestRange) {
                bestRange = range;
                bestIdx = idx;
                bestChannel = channel;
            }
        });

        if (bestIdx === -1 || bestRange === 0) break; // nothing left worth splitting

        const bucket = buckets[bestIdx];
        const sorted = [...bucket].sort(
            (a, b) => pixels[a][bestChannel] - pixels[b][bestChannel]
        );
        const mid = Math.floor(sorted.length / 2);
        const left = sorted.slice(0, mid);
        const right = sorted.slice(mid);

        buckets.splice(bestIdx, 1, left, right);
    }

    // Average each bucket into its final representative color.
    const palette = buckets.map(bucket => {
        let r = 0, g = 0, b = 0;
        for (const i of bucket) {
            r += pixels[i][0];
            g += pixels[i][1];
            b += pixels[i][2];
        }
        const n = bucket.length;
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
    });

    // Map every original pixel to its bucket's palette color.
    const indices = new Array(pixels.length);
    buckets.forEach((bucket, paletteIdx) => {
        for (const i of bucket) indices[i] = paletteIdx;
    });

    const quantizedPixels = indices.map(idx => palette[idx]);
    return { palette, quantizedPixels };
}

// ---------- PIXEL ART GENERATOR ----------
app.get("/pixel-art", async (req, res) => {
    try {
        const url = req.query.url;
        const size = parseInt(req.query.size || "48");
        const colors = Math.max(1, parseInt(req.query.colors || "32"));
        const intensity = parseFloat(req.query.intensity || "1");
        if (!url) return res.status(400).send("missing url");

        const img = await axios.get(url, { responseType: "arraybuffer" });
        const imgBuffer = Buffer.from(img.data);

        // ---- content moderation check ----
        const moderation = await isImageSafe(imgBuffer);
        if (!moderation.safe) {
            return res.status(403).json({
                error: "image flagged by content moderation",
                category: moderation.flagged.className
            });
        }

        const { data, info } = await sharp(imgBuffer)
            .resize(size, size, { fit: "cover" })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const rawPixels = [];
        for (let i = 0; i < data.length; i += 3) {
            let r = data[i];
            let g = data[i + 1];
            let b = data[i + 2];
            // 🎨 intensity boost
            r = Math.min(255, r * intensity);
            g = Math.min(255, g * intensity);
            b = Math.min(255, b * intensity);
            rawPixels.push([r, g, b]);
        }

        // Quantize down to at most `colors` representative colors so the
        // build doesn't end up with near-duplicate shades for every
        // antialiased edge — this is what actually drives build speed
        // and the size of the in-game color list, not the raw color count.
        const { palette, quantizedPixels } = quantizeColors(rawPixels, colors);

        res.json({
            size: info.width,
            pixels: quantizedPixels,
            palette,
            settings: {
                colors: palette.length,
                intensity,
                cellSize: size
            }
        });
    } catch (err) {
        console.log(err.message);
        res.status(500).send("pixel error");
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Spotify pixel server running");
});
