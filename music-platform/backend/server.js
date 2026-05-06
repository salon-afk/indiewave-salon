const { BlobServiceClient } = require("@azure/storage-blob");
const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const multer = require("multer");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const fs = require("fs");
const mm = require("music-metadata");

const app = express();
const PORT = 3000;
const SECRET = "indiewave_secret_key";

const blobServiceClient = BlobServiceClient.fromConnectionString(
  process.env.AZURE_STORAGE_CONNECTION_STRING || ""
);
const containerName = process.env.AZURE_STORAGE_CONTAINER || "music-files";

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicPath = path.join(__dirname, "../public");
const uploadsPath = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsPath)) fs.mkdirSync(uploadsPath);

app.use(express.static(publicPath));
app.use("/uploads", express.static(uploadsPath));

const db = new sqlite3.Database("./database.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    artist TEXT,
    album TEXT,
    genre TEXT,
    mood TEXT,
    language TEXT,
    release_year TEXT,
    duration TEXT,
    file_size TEXT,
    mime_type TEXT,
    bitrate TEXT,
    tags TEXT,
    description TEXT,
    file_path TEXT,
    uploaded_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS favourites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    song_id INTEGER,
    UNIQUE(user_id, song_id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS playlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    description TEXT,
    user_id INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS playlist_songs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id INTEGER,
    song_id INTEGER,
    UNIQUE(playlist_id, song_id)
  )`);
});

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

app.post("/api/register", async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: "Please fill all fields" });
  }

  const hashed = await bcrypt.hash(password, 10);

  db.run(
    "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
    [name, email, hashed],
    function (err) {
      if (err) return res.status(400).json({ message: "Email already exists" });
      res.json({ message: "Registered successfully" });
    }
  );
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  db.get("SELECT * FROM users WHERE email = ?", [email], async (err, user) => {
    if (!user) return res.status(400).json({ message: "Invalid email or password" });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(400).json({ message: "Invalid email or password" });

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email }, SECRET);
    res.json({ message: "Login successful", token, user: { id: user.id, name: user.name, email: user.email } });
  });
});

app.post("/api/songs", auth, upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: "Audio file required" });

  let duration = "";
  let bitrate = "";

  try {
    const meta = await mm.parseFile(req.file.path);
    duration = meta.format.duration ? Math.round(meta.format.duration) + " sec" : "";
    bitrate = meta.format.bitrate ? Math.round(meta.format.bitrate / 1000) + " kbps" : "";
  } catch {}

  let fileUrl = "/uploads/" + req.file.filename;

  try {
    const containerClient = blobServiceClient.getContainerClient(containerName);
    const blockBlobClient = containerClient.getBlockBlobClient(req.file.filename);

    await blockBlobClient.uploadFile(req.file.path, {
      blobHTTPHeaders: {
        blobContentType: req.file.mimetype
      }
    });

    fileUrl = blockBlobClient.url;

    fs.unlinkSync(req.file.path);
  } catch (error) {
    console.log("Blob upload failed, using local upload:", error.message);
  }

  const {
    title, artist, album, genre, mood,
    language, release_year, tags, description
  } = req.body;

  db.run(
    `INSERT INTO songs 
    (title, artist, album, genre, mood, language, release_year, duration, file_size, mime_type, bitrate, tags, description, file_path, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      title, artist, album, genre, mood, language, release_year,
      duration,
      req.file.size + " bytes",
      req.file.mimetype,
      bitrate,
      tags,
      description,
      fileUrl,
      req.user.id
    ],
    function (err) {
      if (err) return res.status(500).json({ message: "Upload failed" });
      res.json({ message: "Song uploaded successfully" });
    }
  );
});

app.get("/api/songs", auth, (req, res) => {
  const q = `%${req.query.search || ""}%`;
  const genre = req.query.genre || "";

  let sql = `
    SELECT songs.*,
    CASE WHEN favourites.id IS NULL THEN 0 ELSE 1 END AS liked
    FROM songs
    LEFT JOIN favourites ON songs.id = favourites.song_id AND favourites.user_id = ?
    WHERE (title LIKE ? OR artist LIKE ? OR album LIKE ? OR genre LIKE ? OR mood LIKE ? OR tags LIKE ?)
  `;

  const params = [req.user.id, q, q, q, q, q, q];

  if (genre) {
    sql += " AND genre = ?";
    params.push(genre);
  }

  sql += " ORDER BY songs.id DESC";

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ message: "Could not load songs" });
    res.json(rows);
  });
});

app.put("/api/songs/:id", auth, (req, res) => {
  const { title, artist, album, genre, mood, language, release_year, tags, description } = req.body;

  db.run(
    `UPDATE songs SET title=?, artist=?, album=?, genre=?, mood=?, language=?, release_year=?, tags=?, description=? WHERE id=?`,
    [title, artist, album, genre, mood, language, release_year, tags, description, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ message: "Update failed" });
      res.json({ message: "Song updated successfully" });
    }
  );
});

app.delete("/api/songs/:id", auth, (req, res) => {
  db.get("SELECT file_path FROM songs WHERE id=?", [req.params.id], (err, song) => {
    if (song && song.file_path) {
      const fullPath = path.join(__dirname, song.file_path.replace("/uploads", "uploads"));
      if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
    }

    db.run("DELETE FROM songs WHERE id=?", [req.params.id], () => {
      res.json({ message: "Song deleted successfully" });
    });
  });
});

app.post("/api/favourites/:songId", auth, (req, res) => {
  db.run(
    "INSERT OR IGNORE INTO favourites (user_id, song_id) VALUES (?, ?)",
    [req.user.id, req.params.songId],
    () => res.json({ message: "Added to favourites" })
  );
});

app.delete("/api/favourites/:songId", auth, (req, res) => {
  db.run(
    "DELETE FROM favourites WHERE user_id=? AND song_id=?",
    [req.user.id, req.params.songId],
    () => res.json({ message: "Removed from favourites" })
  );
});

app.get("/api/favourites", auth, (req, res) => {
  db.all(
    `SELECT songs.* FROM songs
     JOIN favourites ON songs.id = favourites.song_id
     WHERE favourites.user_id = ?
     ORDER BY favourites.id DESC`,
    [req.user.id],
    (err, rows) => res.json(rows || [])
  );
});

app.post("/api/playlists", auth, (req, res) => {
  const { name, description } = req.body;

  db.run(
    "INSERT INTO playlists (name, description, user_id) VALUES (?, ?, ?)",
    [name, description, req.user.id],
    () => res.json({ message: "Playlist created" })
  );
});

app.get("/api/playlists", auth, (req, res) => {
  db.all("SELECT * FROM playlists WHERE user_id=? ORDER BY id DESC", [req.user.id], (err, rows) => {
    res.json(rows || []);
  });
});

app.post("/api/playlists/:playlistId/songs/:songId", auth, (req, res) => {
  db.run(
    "INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id) VALUES (?, ?)",
    [req.params.playlistId, req.params.songId],
    () => res.json({ message: "Song added to playlist" })
  );
});

app.get("/api/playlists/:id/songs", auth, (req, res) => {
  db.all(
    `SELECT songs.* FROM songs
     JOIN playlist_songs ON songs.id = playlist_songs.song_id
     WHERE playlist_songs.playlist_id=?`,
    [req.params.id],
    (err, rows) => res.json(rows || [])
  );
});

app.delete("/api/playlists/:id", auth, (req, res) => {
  db.run("DELETE FROM playlist_songs WHERE playlist_id=?", [req.params.id], () => {
    db.run(
      "DELETE FROM playlists WHERE id=? AND user_id=?",
      [req.params.id, req.user.id],
      function (err) {
        if (err) return res.status(500).json({ message: "Playlist delete failed" });
        res.json({ message: "Playlist deleted successfully" });
      }
    );
  });
});

app.use((req, res) => {
  res.sendFile(path.join(publicPath, "index.html"));
});

app.listen(PORT, () => {
  console.log(`IndieWave running at http://localhost:${PORT}`);
});