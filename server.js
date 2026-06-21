import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import sharp from "sharp";

dotenv.config();

const app = express();
app.use(cors());

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
app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        const token = await getToken();

        const response = await axios.get(
            "https://api.spotify.com/v1/search",
            {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                    q,
                    type: "album",
                    limit: 10,
                },
            }
        );

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

        if (!url) return res.status(400).send("missing url");

        const img = await axios.get(url, {
            responseType: "arraybuffer"
        });

        // resize + raw pixel data
        const { data, info } = await sharp(img.data)
            .resize(size, size, { fit: "cover" })
            .raw()
            .toBuffer({ resolveWithObject: true });

        const pixels = [];

        for (let i = 0; i < data.length; i += 3) {
            pixels.push([
                data[i],
                data[i + 1],
                data[i + 2]
            ]);
        }

        res.json({
            size: info.width,
            pixels
        });

    } catch (err) {
        console.log(err.message);
        res.status(500).send("pixel error");
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Spotify pixel server running");
});
