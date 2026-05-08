let allSongs = [];
let token = localStorage.getItem("token");
let currentUser = JSON.parse(localStorage.getItem("user") || "null");

const $ = id => document.getElementById(id);

function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $(id).classList.add("active");

  if (id === "library") loadSongs();
  if (id === "favourites") loadFavourites();
  if (id === "playlists") loadPlaylists();
}

function setStatus() {
  $("userStatus").textContent = token ? `Logged in as ${currentUser.name}` : "Not logged in";
}
setStatus();

async function register() {
  const res = await fetch("/api/register", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      name: $("name").value,
      email: $("email").value,
      password: $("password").value
    })
  });

  const data = await res.json();
  $("authMessage").textContent = data.message;
}

async function loginUser() {
  const email = document.querySelector('#email').value;
  const password = document.querySelector('#password').value;

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ email, password })
  });

  const data = await res.json();

  if (data.token) {
    localStorage.setItem('token', data.token);
    localStorage.setItem('user', JSON.stringify(data.user));

    alert('Login successful ✅');

    // 👉 UPDATE UI
    showUser();
  } else {
    alert(data.message);
  }
}

function showUser() {
  const user = JSON.parse(localStorage.getItem('user'));

  if (user) {
    document.getElementById('userStatus').innerText =
      `Logged in as ${user.name}`;
  }
}

function logoutUser() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  location.reload();
}

showUser();

async function uploadSong() {
  if (!token) return alert("Please login first");

  const form = new FormData();

  [
    "title", "artist", "album", "genre", "mood",
    "language", "release_year", "tags", "description"
  ].forEach(id => form.append(id, $(id).value));

  const audioFile = $("audio").files[0];

  if (!audioFile) {
    $("uploadMessage").textContent = "Please choose a music file.";
    return;
  }

  form.append("audio", audioFile);

  const res = await fetch("/api/songs", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form
  });

  const data = await res.json();
  $("uploadMessage").textContent = data.message;

  if (res.ok) {
    [
      "title", "artist", "album", "genre", "mood",
      "language", "release_year", "tags", "description"
    ].forEach(id => $(id).value = "");

    $("audio").value = "";

    setTimeout(() => {
      $("uploadMessage").textContent = "";
    }, 3000);

    loadSongs();
    showView("library");
  }
}

async function loadSongs() {
  if (!token) return;

  const search = $("search").value;
  const genre = $("genreFilter").value;

  const res = await fetch(`/api/songs?search=${search}&genre=${genre}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const songs = await res.json();
  allSongs = songs;
  renderSongs(songs, "songs");
}

function renderSongs(songs, containerId) {
  const container = $(containerId);
  container.innerHTML = "";

  songs.forEach(song => {
    const div = document.createElement("div");
    div.className = "song";

    div.innerHTML = `
      <div class="cover">🎵</div>
      <h3>${song.title || "Untitled"}</h3>
      <p><b>${song.artist || "Unknown Artist"}</b></p>
      <p>${song.album || ""} • ${song.genre || ""} • ${song.mood || ""}</p>
      <p>${song.description || ""}</p>
      <p>
        <span class="tag">${song.language || "Music"}</span>
        <span class="tag">${song.release_year || "Year"}</span>
      </p>
      <button onclick='playSong(${JSON.stringify(song)})'>Play</button>
      <button onclick='viewMetadata(${JSON.stringify(song)})' class="secondary">View Info</button>
      <button onclick='toggleFavourite(${song.id}, ${song.liked || 0})'>${song.liked ? "♥ Liked" : "♡ Like"}</button>
      <button onclick='openEdit(${JSON.stringify(song)})'>Edit</button>
      <button onclick='deleteSong(${song.id})' class="secondary">Delete</button>
      <button onclick='quickAddToPlaylist(${song.id})' class="secondary">Add to Playlist</button>
    `;

    container.appendChild(div);
  });
}

function playSong(song) {
  const player = $("audioPlayer");

  if (song.file_path.startsWith("http")) {
    player.src = song.file_path;
  } else {
    player.src = window.location.origin + song.file_path;
  }

  player.load();
  player.play();

  $("nowTitle").textContent = song.title || "Untitled";
  $("nowArtist").textContent = song.artist || "Unknown Artist";
}

async function toggleFavourite(songId, liked) {
  await fetch(`/api/favourites/${songId}`, {
    method: liked ? "DELETE" : "POST",
    headers: { Authorization: `Bearer ${token}` }
  });

  loadSongs();
  loadFavourites();
}

async function loadFavourites() {
  const res = await fetch("/api/favourites", {
    headers: { Authorization: `Bearer ${token}` }
  });

  const songs = await res.json();
  renderSongs(songs, "favSongs");
}

function openEdit(song) {
  $("editModal").classList.remove("hidden");
  $("editId").value = song.id;
  $("editTitle").value = song.title || "";
  $("editArtist").value = song.artist || "";
  $("editAlbum").value = song.album || "";
  $("editGenre").value = song.genre || "";
  $("editMood").value = song.mood || "";
  $("editLanguage").value = song.language || "";
  $("editYear").value = song.release_year || "";
  $("editTags").value = song.tags || "";
  $("editDescription").value = song.description || "";
}

function closeEdit() {
  $("editModal").classList.add("hidden");
}

async function saveEdit() {
  const id = $("editId").value;

  await fetch(`/api/songs/${id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      title: $("editTitle").value,
      artist: $("editArtist").value,
      album: $("editAlbum").value,
      genre: $("editGenre").value,
      mood: $("editMood").value,
      language: $("editLanguage").value,
      release_year: $("editYear").value,
      tags: $("editTags").value,
      description: $("editDescription").value
    })
  });

  closeEdit();
  loadSongs();
}

async function deleteSong(id) {
  if (!confirm("Delete this song?")) return;

  await fetch(`/api/songs/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });

  loadSongs();
}

async function createPlaylist() {
  await fetch("/api/playlists", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      name: $("playlistName").value,
      description: $("playlistDescription").value
    })
  });

  loadPlaylists();
}

async function loadPlaylists() {
  const res = await fetch("/api/playlists", {
    headers: { Authorization: `Bearer ${token}` }
  });

  const playlists = await res.json();
  const box = $("playlistList");
  box.innerHTML = "";

  playlists.forEach(p => {
    const div = document.createElement("div");
    div.className = "playlist";
    div.innerHTML = `
      <h3>${p.name}</h3>
      <p>${p.description || ""}</p>
      <button onclick="viewPlaylistSongs(${p.id})">View Songs</button>
      <button onclick="deletePlaylist(${p.id})" class="secondary">Delete</button>
    `;
    box.appendChild(div);
  });
}

async function quickAddToPlaylist(songId) {
  const res = await fetch("/api/playlists", {
    headers: { Authorization: `Bearer ${token}` }
  });

  const playlists = await res.json();

  if (playlists.length === 0) {
    alert("Create a playlist first.");
    showView("playlists");
    return;
  }

  const playlistId = playlists[0].id;

  await fetch(`/api/playlists/${playlistId}/songs/${songId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` }
  });

  alert("Song added to your first playlist");
}

async function viewPlaylistSongs(id) {
  const res = await fetch(`/api/playlists/${id}/songs`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const songs = await res.json();
  renderSongs(songs, "playlistList");
}

function viewMetadata(song) {
  $("metaModal").classList.remove("hidden");

  $("metaTitle").textContent = song.title || "-";
  $("metaArtist").textContent = song.artist || "-";
  $("metaAlbum").textContent = song.album || "-";
  $("metaGenre").textContent = song.genre || "-";
  $("metaMood").textContent = song.mood || "-";
  $("metaLanguage").textContent = song.language || "-";
  $("metaYear").textContent = song.release_year || "-";
  $("metaDuration").textContent = song.duration || "-";
  $("metaBitrate").textContent = song.bitrate || "-";
  $("metaSize").textContent = song.file_size || "-";
  $("metaTags").textContent = song.tags || "-";
  $("metaDesc").textContent = song.description || "-";
}

function closeMetadata() {
  $("metaModal").classList.add("hidden");
}

async function deletePlaylist(id) {
  if (!confirm("Delete this playlist?")) return;

  const res = await fetch(`/api/playlists/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await res.json();
  alert(data.message);

  loadPlaylists();
}

function shufflePlay() {
  if (!allSongs.length) {
    alert("No songs available");
    return;
  }

  const randomIndex = Math.floor(Math.random() * allSongs.length);
  const randomSong = allSongs[randomIndex];

  playSong(randomSong);
}

loadSongs();
