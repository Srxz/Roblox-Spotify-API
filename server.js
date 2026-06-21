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
// Loaded once at startup and kept in memory. First request may be slow
// on Render if the instance just spun up (cold start), but subsequent
// requests reuse this cached model.
let nsfwModel = null;
let nsfwModelLoading = null;

async function getNsfwModel() {
    if (nsfwModel) return nsfwModel;
    if (!nsfwModelLoading) {
        nsfwModelLoading = nsfwjs.load().then(model => {
            nsfwModel = model;
            return model;
        });
    }
    return nsfwModelLoading;
}

// Kick off loading immediately on server start so it's warm before
// the first request arrives (best-effort, errors logged not thrown).
getNsfwModel().catch(err =>
    console.log("nsfw model preload failed:", err.message)
);

// Thresholds: tweak these if you get false positives/negatives.
const NSFW_THRESHOLDS = {
    Porn: 0.6,
    Hentai: 0.6,
    Sexy: 0.75
};

async function isImageSafe(buffer) {
    const model = await getNsfwModel();
    // nsfwjs needs a decoded tensor; decode via tf.node from the raw bytes.
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
// GET /search?q=...&type=album|track  (defaults to album)
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        const type = req.query.type === "track" ? "track" : "album";

        const token = await getToken();
        const response = await axios.get(
            "https://api.spotify.com/v1/search",
            {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                    q,
                    type,
                    limit: 10,
                },
            }
        );

        if (type === "track") {
            const tracks = response.data.tracks.items.map(t => ({
                id: t.id,
                name: t.name,
                artist: t.artists.map(x => x.name).join(", "),
                album: t.album?.name,
                image: t.album?.images?.[0]?.url,
                explicit: t.explicit,
                previewUrl: t.preview_url,
            }));
            return res.json(tracks);
        }

        const albums = response.data.albums.items.map(a => ({
            id: a.id,
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

// ---------- PIXEL ART GENERATOR ----------
app.get("/pixel-art", async (req, res) => {
    try {
        const url = req.query.url;
        const size = parseInt(req.query.size || "48");
        const colors = parseInt(req.query.colors || "32");
        const intensity = parseFloat(req.query.intensity || "1");
        if (!url) return res.status(400).send("missing url");

        const img = await axios.get(url, {
            responseType: "arraybuffer"
        });
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
        const pixels = [];
        for (let i = 0; i < data.length; i += 3) {
            let r = data[i];
            let g = data[i + 1];
            let b = data[i + 2];
            // 🎨 intensity boost
            r = Math.min(255, r * intensity);
            g = Math.min(255, g * intensity);
            b = Math.min(255, b * intensity);
            pixels.push([r, g, b]);
        }
        res.json({
            size: info.width,
            pixels,
            settings: {
                colors,
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
