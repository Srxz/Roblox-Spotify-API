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

app.get("/search-albums", async (req, res) => {
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
                    q: `album:${q}`,
                    type: "album",
                    limit: 10,
                },
            }
        );

        const albums = response.data.albums.items.map(a => ({
            id: a.id,
            name: a.name,
            artist: a.artists.map(x => x.name).join(", "),
            image: a.images?.[0]?.url,
        }));

        res.json(albums);
    } catch (err) {
        console.error(err.response?.data || err.message);
        res.status(500).json({ error: "Spotify request failed" });
    }
});

app.listen(process.env.PORT || 3000, () => {
    console.log("Spotify proxy running");
});