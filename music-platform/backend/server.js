const { BlobServiceClient } = require("@azure/storage-blob");
require("dotenv").config();
const { CosmosClient } = require("@azure/cosmos");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 8080;
const SECRET = process.env.JWT_SECRET || "indiewave_secret_key";

const cosmosClient = new CosmosClient({
  endpoint: process.env.COSMOS_ENDPOINT,
  key: process.env.COSMOS_KEY
});

const database = cosmosClient.database(process.env.COSMOS_DATABASE_ID || "indiewave-db");
const usersContainer = database.container("users");
const songsContainer = database.container("songs");
const favouritesContainer = database.container("favourites");
const playlistsContainer = database.container("playlists");

let blobServiceClient = null;
if (process.env.AZURE_STORAGE_CONNECTION_STRING) {
  blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
}
const containerName = process.env.AZURE_STORAGE_CONTAINER || "music-files";

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicPath = path.join(__dirname, "../public");
const uploadsPath = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath);

app.use(express.static(publicPath));
app.use("/uploads", express.static(uploadsPath));

const storage = multer.diskStorage({
  destination: uploadsPath,
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + file.originalname.replace(/\s+/g, "-");
    cb(null, unique);
  }
});
const upload = multer({ storage });

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ message: "No token provided" });

  const token = header.split(" ")[1];
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

function newId() {
  return Date.now().toString();
}

app.get("/test", async (req, res) => {
  res.json({ message: "Cosmos backend working" });
});

app.post("/api/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ message: "Please fill all fields" });

    const query = {
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }]
    };

    const { resources } = await usersContainer.items.query(query).fetchAll();
    if (resources.length > 0) return res.status(400).json({ message: "Email already exists" });

    const hashed = await bcrypt.hash(password, 10);
    const user = {
      id: newId(),
      name,
      email,
      password: hashed,
      created_at: new Date().toISOString()
    };

    await usersContainer.items.create(user);
    res.json({ message: "Registered successfully" });
  } catch (err) {
    res.status(500).json({ message: "Register failed", error: err.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const query = {
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }]
    };

    const { resources } = await usersContainer.items.query(query).fetchAll();
    const user = resources[0];

    if (!user) return res.status(400).json({ message: "Invalid email or password" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: "Invalid email or password" });

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, SECRET);
    res.json({
      message: "Login successful",
      token,
      user: { id: user.id, name: user.name, email: user.email }
    });
  } catch (err) {
    res.status(500).json({ message: "Login failed", error: err.message });
  }
});

app.post("/api/songs", auth, upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "Audio file required" });

    let duration = "";
    let bitrate = "";

    try {
      const mm = await import("music-metadata");
      const meta = await mm.parseFile(req.file.path);
      duration = meta.format.duration ? Math.round(meta.format.duration) + " sec" : "";
      bitrate = meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) + " kbps" : "";
    } catch {}

    let fileUrl = "/uploads/" + req.file.filename;

    try {
      if (blobServiceClient) {
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.createIfNotExists();
        const blockBlobClient = containerClient.getBlockBlobClient(req.file.filename);

        await blockBlobClient.uploadFile(req.file.path, {
          blobHTTPHeaders: { blobContentType: req.file.mimetype }
        });

        fileUrl = blockBlobClient.url;
        fs.unlinkSync(req.file.path);
      }
    } catch (error) {
      console.log("Blob upload failed, using local upload:", error.message);
    }

    const song = {
      id: newId(),
      title: req.body.title || "",
      artist: req.body.artist || "",
      album: req.body.album || "",
      genre: req.body.genre || "",
      mood: req.body.mood || "",
      language: req.body.language || "",
      release_year: req.body.release_year || "",
      duration,
      file_size: req.file.size + " bytes",
      mime_type: req.file.mimetype,
      bitrate,
      tags: req.body.tags || "",
      description: req.body.description || "",
      file_path: fileUrl,
      uploaded_by: req.user.id,
      created_at: new Date().toISOString()
    };

    await songsContainer.items.create(song);
    res.json({ message: "Song uploaded successfully" });
  } catch (err) {
    res.status(500).json({ message: "Upload failed", error: err.message });
  }
});

app.get("/api/songs", auth, async (req, res) => {
  try {
    const search = (req.query.search || "").toLowerCase();
    const genre = req.query.genre || "";

    const { resources: songs } = await songsContainer.items.readAll().fetchAll();
    const { resources: favs } = await favouritesContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.user_id = @user_id",
        parameters: [{ name: "@user_id", value: req.user.id }]
      })
      .fetchAll();

    const favIds = favs.map(f => f.song_id);

    let filtered = songs;

    if (search) {
      filtered = filtered.filter(s =>
        `${s.title} ${s.artist} ${s.album} ${s.genre} ${s.mood} ${s.tags}`.toLowerCase().includes(search)
      );
    }

    if (genre) {
      filtered = filtered.filter(s => s.genre === genre);
    }

    filtered = filtered
      .map(s => ({ ...s, liked: favIds.includes(s.id) ? 1 : 0 }))
      .sort((a, b) => Number(b.id) - Number(a.id));

    res.json(filtered);
  } catch (err) {
    res.status(500).json({ message: "Could not load songs", error: err.message });
  }
});

app.put("/api/songs/:id", auth, async (req, res) => {
  try {
    const { resource: song } = await songsContainer.item(req.params.id, req.params.id).read();
    if (!song) return res.status(404).json({ message: "Song not found" });

    const updated = { ...song, ...req.body };
    await songsContainer.item(req.params.id, req.params.id).replace(updated);

    res.json({ message: "Song updated successfully" });
  } catch (err) {
    res.status(500).json({ message: "Update failed", error: err.message });
  }
});

app.delete("/api/songs/:id", auth, async (req, res) => {
  try {
    await songsContainer.item(req.params.id, req.params.id).delete();
    res.json({ message: "Song deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Delete failed", error: err.message });
  }
});

app.post("/api/favourites/:songId", auth, async (req, res) => {
  try {
    const fav = {
      id: `${req.user.id}-${req.params.songId}`,
      user_id: req.user.id,
      song_id: req.params.songId
    };

    await favouritesContainer.items.upsert(fav);
    res.json({ message: "Added to favourites" });
  } catch (err) {
    res.status(500).json({ message: "Favourite failed", error: err.message });
  }
});

app.delete("/api/favourites/:songId", auth, async (req, res) => {
  try {
    const id = `${req.user.id}-${req.params.songId}`;
    await favouritesContainer.item(id, id).delete();
    res.json({ message: "Removed from favourites" });
  } catch {
    res.json({ message: "Removed from favourites" });
  }
});

app.get("/api/favourites", auth, async (req, res) => {
  try {
    const { resources: favs } = await favouritesContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.user_id = @user_id",
        parameters: [{ name: "@user_id", value: req.user.id }]
      })
      .fetchAll();

    const { resources: songs } = await songsContainer.items.readAll().fetchAll();
    const favIds = favs.map(f => f.song_id);

    res.json(songs.filter(s => favIds.includes(s.id)));
  } catch (err) {
    res.status(500).json({ message: "Could not load favourites", error: err.message });
  }
});

app.post("/api/playlists", auth, async (req, res) => {
  try {
    const playlist = {
      id: newId(),
      name: req.body.name,
      description: req.body.description || "",
      user_id: req.user.id,
      songs: [],
      created_at: new Date().toISOString()
    };

    await playlistsContainer.items.create(playlist);
    res.json({ message: "Playlist created" });
  } catch (err) {
    res.status(500).json({ message: "Playlist failed", error: err.message });
  }
});

app.get("/api/playlists", auth, async (req, res) => {
  try {
    const { resources } = await playlistsContainer.items
      .query({
        query: "SELECT * FROM c WHERE c.user_id = @user_id",
        parameters: [{ name: "@user_id", value: req.user.id }]
      })
      .fetchAll();

    res.json(resources.sort((a, b) => Number(b.id) - Number(a.id)));
  } catch (err) {
    res.status(500).json({ message: "Could not load playlists", error: err.message });
  }
});

app.post("/api/playlists/:playlistId/songs/:songId", auth, async (req, res) => {
  try {
    const { resource: playlist } = await playlistsContainer.item(req.params.playlistId, req.params.playlistId).read();

    if (!playlist.songs) playlist.songs = [];
    if (!playlist.songs.includes(req.params.songId)) playlist.songs.push(req.params.songId);

    await playlistsContainer.item(req.params.playlistId, req.params.playlistId).replace(playlist);
    res.json({ message: "Song added to playlist" });
  } catch (err) {
    res.status(500).json({ message: "Could not add song", error: err.message });
  }
});

app.get("/api/playlists/:id/songs", auth, async (req, res) => {
  try {
    const { resource: playlist } = await playlistsContainer.item(req.params.id, req.params.id).read();
    const { resources: songs } = await songsContainer.items.readAll().fetchAll();

    res.json(songs.filter(s => playlist.songs && playlist.songs.includes(s.id)));
  } catch (err) {
    res.status(500).json({ message: "Could not load playlist songs", error: err.message });
  }
});

app.delete("/api/playlists/:id", auth, async (req, res) => {
  try {
    await playlistsContainer.item(req.params.id, req.params.id).delete();
    res.json({ message: "Playlist deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Playlist delete failed", error: err.message });
  }
});

app.use((req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`IndieWave running on port ${PORT}`);
});