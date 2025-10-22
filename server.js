require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bodyParser = require("body-parser");
const QRCode = require("qrcode");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5000;

// ---------------- Middleware ----------------
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ---------------- Serve Frontend ----------------
const frontendPath = path.join(__dirname, "../Frontend");
app.use(express.static(frontendPath));
app.get("/", (req, res) => res.sendFile(path.join(frontendPath, "index.html")));
app.get("/qrscanner.html", (req, res) => res.sendFile(path.join(frontendPath, "qrscanner.html")));

// ---------------- MongoDB connection ----------------
(async () => {
  try {
    console.log("🔄 Connecting to MongoDB...");
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ MongoDB Connected Successfully");
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err.message);
  }
})();

// ---------------- Schemas ----------------
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  userId: { type: String, unique: true, required: true },
  bus: { type: String, required: true },
  role: { type: String, enum: ["user", "admin"], required: true },
  password: { type: String, required: true },
  qrCode: String,
  attendance: { type: String, default: "Absent" },
}, { timestamps: true });

const User = mongoose.model("User", userSchema);

const attendanceSchema = new mongoose.Schema({
  userId: String,
  bus: String, // <-- include bus field for filtering
  date: { type: Date, default: Date.now },
  status: { type: String, enum: ["Present", "Absent"], default: "Absent" },
});

const Attendance = mongoose.model("Attendance", attendanceSchema);

// ---------------- ROUTES ----------------

// ✅ Register user
app.post("/api/users/register", async (req, res) => {
  try {
    const { name, userId, bus, role, password } = req.body;
    if (!name || !bus || !role || !password || !userId)
      return res.status(400).json({ message: "All fields are required" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const finalUserId = userId || uuidv4();

    const newUser = new User({ name, bus, role, userId: finalUserId, password: hashedPassword });

    // QR data in JSON
    if (role === "user") {
      const qrData = { userId: newUser.userId, name, bus, role };
      newUser.qrCode = JSON.stringify(qrData);
    }

    await newUser.save();
    res.status(201).json({ message: "User registered successfully", userId: newUser.userId, role });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ Login user
app.post("/api/users/login", async (req, res) => {
  try {
    const { userId, password } = req.body;
    if (!userId || !password)
      return res.status(400).json({ message: "Enter both ID and password" });

    const user = await User.findOne({ userId: userId.trim() });
    if (!user) return res.status(404).json({ message: "User not found" });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ message: "Invalid password" });

    res.json({
      name: user.name,
      userId: user.userId,
      bus: user.bus,
      role: user.role,
      qrCode: user.qrCode,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ QR Scan (Main validation route)
app.post("/api/qr/scan", async (req, res) => {
  try {
    const { scannedData, adminBus } = req.body;
    if (!scannedData || !adminBus)
      return res.status(400).json({ message: "Missing scanned data or admin bus" });

    let parsed;
    try {
      parsed = typeof scannedData === "string" ? JSON.parse(scannedData) : scannedData;
    } catch {
      return res.status(400).json({ message: "Invalid QR format" });
    }

    if (!parsed.userId) return res.status(400).json({ message: "QR missing userId field" });

    const user = await User.findOne({ userId: parsed.userId });
    if (!user) return res.status(404).json({ message: "User not found" });

    if (parsed.bus !== adminBus) {
      return res.status(400).json({ message: "❌ Invalid User for this Bus" });
    }

    user.attendance = "Present";
    await user.save();

    const today = new Date();
    const start = new Date(today.setHours(0, 0, 0, 0));
    const end = new Date(today.setHours(23, 59, 59, 999));

    const existing = await Attendance.findOne({
      userId: user.userId,
      date: { $gte: start, $lt: end },
    });

    if (!existing) await new Attendance({ userId: user.userId, bus: user.bus, status: "Present" }).save();

    res.json({ message: "✅ Valid User - Attendance Marked Present", user: user.name, bus: user.bus });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ Attendance summary per user
app.get("/api/attendance/:userId/:month/:year", async (req, res) => {
  try {
    const { userId, month, year } = req.params;
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59);

    const records = await Attendance.find({ userId, date: { $gte: start, $lte: end } });
    const presentDays = records.filter((r) => r.status === "Present").length;
    const totalDays = new Date(year, month, 0).getDate();

    res.json({
      userId,
      month,
      year,
      totalDays,
      presentDays,
      absentDays: totalDays - presentDays,
      details: records,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ Auto Absent (for unscanned users)
app.post("/api/auto-absent", async (req, res) => {
  try {
    const today = new Date();
    const start = new Date(today.setHours(0, 0, 0, 0));
    const end = new Date(today.setHours(23, 59, 59, 999));
    const users = await User.find({ role: "user" });

    for (let user of users) {
      const existing = await Attendance.findOne({
        userId: user.userId,
        date: { $gte: start, $lt: end },
      });
      if (!existing) await new Attendance({ userId: user.userId, bus: user.bus, status: "Absent" }).save();
    }

    res.json({ message: "All unscanned users marked absent ✅" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ✅ Fetch all users (Admin panel) **Updated to filter by bus**
app.get("/api/users/:bus", async (req, res) => {
  try {
    const busNumber = req.params.bus;
    const users = await User.find({ bus: busNumber, role: "user" }, "-password -qrCode");
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ---------------- Start Server ----------------
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
