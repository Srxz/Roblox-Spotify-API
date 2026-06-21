import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(cors());

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

app.get("/image", async (req, res) => {
    try {
        const url = req.query.url;
        if (!url) return res.status(400).send("No URL");

        const response = await axios.get(url, {
            responseType: "arraybuffer"
        });

        res.set("Content-Type", "image/jpeg");
        res.send(response.data);

    } catch (err) {
        res.status(500).send("Failed");
    }
});

app.get("/search", async (req, res) => {
    try {
        const q = req.query.q;
        if (!q) return res.status(400).json({ error: "Missing query" });

        const token = await getToken();

        const response = await axios.get(
            "https://api.spotify.com/v1/search",
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
                params: {
                    q: q,
                    type: "album,artist",
                    limit: 10,
                },
            }
        );

        // ALBUMS
        const albums = response.data.albums.items.map(a => ({
            type: "album",
            id: a.id,
            name: a.name,
            artist: a.artists.map(x => x.name).join(", "),
            image: a.images?.[0]?.url,
        }));

        // ARTISTS
        const artists = response.data.artists.items.map(a => ({
            type: "artist",
            id: a.id,
            name: a.name,
            image: a.images?.[0]?.url || null,
        }));

        res.json({
            albums,
            artists,
        });

    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ error: "Spotify request failed" });
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Spotify proxy running");
});
