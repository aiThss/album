require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v2: cloudinary } = require('cloudinary');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
let dbConnected = false; // flag kiểm tra DB có kết nối không

// ─── Cloudinary Config ─────────────────────────────────────────────────────────
let upload;
try {
  if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    });
    const storage = new CloudinaryStorage({
      cloudinary,
      params: {
        folder: 'memory-album',
        allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic'],
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      },
    });
    upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });
    console.log('✅ Cloudinary configured');
  } else {
    // Fallback: lưu local khi chưa cấu hình Cloudinary
    upload = multer({ dest: 'public/uploads/', limits: { fileSize: 20 * 1024 * 1024 } });
    console.log('⚠️  Cloudinary not configured — using local storage fallback');
  }
} catch (err) {
  upload = multer({ dest: 'public/uploads/', limits: { fileSize: 20 * 1024 * 1024 } });
  console.error('❌ Cloudinary init error:', err.message);
}

// ─── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MongoDB Schemas ────────────────────────────────────────────────────────────
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  displayName: { type: String },
  avatarUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
});

const photoSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  url: { type: String, required: true },
  thumbnailUrl: { type: String },
  publicId: { type: String }, // cloudinary public_id
  caption: { type: String, default: '' },
  albumId: { type: mongoose.Schema.Types.ObjectId, ref: 'Album', default: null },
  tags: [String],
  favorite: { type: Boolean, default: false },
  width: Number,
  height: Number,
  size: Number,
  uploadedAt: { type: Date, default: Date.now },
});

const albumSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  name: { type: String, required: true },
  description: { type: String, default: '' },
  coverUrl: { type: String },
  createdAt: { type: Date, default: Date.now },
});

const User = mongoose.model('User', userSchema);
const Photo = mongoose.model('Photo', photoSchema);
const Album = mongoose.model('Album', albumSchema);

// ─── Auth Middleware ─────────────────────────────────────────────────────────────
const authMiddleware = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ─── Routes ─────────────────────────────────────────────────────────────────────

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // ── Fallback: không có DB → dùng credentials trong .env ──────────────
    if (!dbConnected) {
      if (
        username === process.env.ADMIN_USERNAME &&
        password === process.env.ADMIN_PASSWORD
      ) {
        const token = jwt.sign(
          { id: 'local-admin', username },
          process.env.JWT_SECRET,
          { expiresIn: '7d' }
        );
        return res.json({
          token,
          user: {
            id: 'local-admin',
            username,
            displayName: process.env.ADMIN_DISPLAY_NAME || username,
            avatarUrl: null,
          },
        });
      }
      return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
    }

    // ── Normal: có DB ─────────────────────────────────────────────────────
    const user = await User.findOne({ username });
    if (!user) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });

    const token = jwt.sign(
      { id: user._id, username: user.username },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      token,
      user: {
        id: user._id,
        username: user.username,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    if (!dbConnected) {
      return res.json({
        id: 'local-admin',
        username: req.user.username,
        displayName: process.env.ADMIN_DISPLAY_NAME || req.user.username,
      });
    }
    const user = await User.findById(req.user.id).select('-password');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Photos ──────────────────────────────────────────────────────────────────────

// POST /api/photos/upload (upload 1 or multiple)
app.post('/api/photos/upload', authMiddleware, upload.array('photos', 50), async (req, res) => {
  try {
    const { caption, albumId, tags } = req.body;
    const savedPhotos = [];

    for (const file of req.files) {
      const photo = await Photo.create({
        userId: req.user.id,
        url: file.path,
        thumbnailUrl: file.path.replace('/upload/', '/upload/w_400,q_auto/'),
        publicId: file.filename,
        caption: caption || '',
        albumId: albumId || null,
        tags: tags ? tags.split(',').map(t => t.trim()) : [],
        width: file.width,
        height: file.height,
        size: file.size,
      });
      savedPhotos.push(photo);
    }

    res.json({ success: true, photos: savedPhotos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/photos
app.get('/api/photos', authMiddleware, async (req, res) => {
  try {
    const { albumId, favorite, tag, page = 1, limit = 50 } = req.query;
    const filter = { userId: req.user.id };
    if (albumId) filter.albumId = albumId === 'null' ? null : albumId;
    if (favorite === 'true') filter.favorite = true;
    if (tag) filter.tags = tag;

    const photos = await Photo.find(filter)
      .sort({ uploadedAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    const total = await Photo.countDocuments(filter);
    res.json({ photos, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/photos/:id
app.patch('/api/photos/:id', authMiddleware, async (req, res) => {
  try {
    const photo = await Photo.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      req.body,
      { new: true }
    );
    res.json(photo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/photos/:id
app.delete('/api/photos/:id', authMiddleware, async (req, res) => {
  try {
    const photo = await Photo.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    if (photo?.publicId) await cloudinary.uploader.destroy(photo.publicId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Albums ───────────────────────────────────────────────────────────────────────

app.get('/api/albums', authMiddleware, async (req, res) => {
  try {
    const albums = await Album.find({ userId: req.user.id }).sort({ createdAt: -1 });
    // count photos per album
    const result = await Promise.all(
      albums.map(async (a) => {
        const count = await Photo.countDocuments({ albumId: a._id, userId: req.user.id });
        return { ...a.toObject(), photoCount: count };
      })
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/albums', authMiddleware, async (req, res) => {
  try {
    const album = await Album.create({ ...req.body, userId: req.user.id });
    res.json(album);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/albums/:id', authMiddleware, async (req, res) => {
  try {
    await Album.findOneAndDelete({ _id: req.params.id, userId: req.user.id });
    // Move photos back to root
    await Photo.updateMany({ albumId: req.params.id, userId: req.user.id }, { albumId: null });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve SPA ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/album', (req, res) => res.sendFile(path.join(__dirname, 'public', 'album.html')));

// ─── MongoDB Connect + Init Admin ────────────────────────────────────────────────
async function initAdmin() {
  const existing = await User.findOne({ username: process.env.ADMIN_USERNAME });
  if (!existing) {
    const hashed = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await User.create({
      username: process.env.ADMIN_USERNAME,
      password: hashed,
      displayName: process.env.ADMIN_DISPLAY_NAME || process.env.ADMIN_USERNAME,
    });
    console.log(`✅ Admin account created: ${process.env.ADMIN_USERNAME}`);
  }
}

mongoose.connect(process.env.MONGODB_URI)
  .then(async () => {
    dbConnected = true;
    console.log('✅ MongoDB connected');
    await initAdmin();
    app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
  })
  .catch(err => {
    dbConnected = false;
    console.error('❌ MongoDB connection failed:', err.message);
    console.log(`⚠️  Chạy không có DB — đăng nhập bằng .env: ${process.env.ADMIN_USERNAME} / ${process.env.ADMIN_PASSWORD}`);
    app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT} (no DB)`));
  });
