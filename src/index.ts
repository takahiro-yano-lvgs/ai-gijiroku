import express from "express";
import path from "path";
import multer from "multer";
import fs from "fs";

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, "public/uploads");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, decodeURIComponent(file.originalname));
  },
})

const upload = multer({ storage, fileFilter(req, file, cb) {
  if (file.mimetype === "video/mp4") {
    cb(null, true);
    return;
  } else {
    cb(new Error("Invalid file type"));
  }
}, });

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.post("/api/videoes", upload.single("file"), (req, res) => {
  res.redirect(301, "/");
});

app.listen(PORT, () => {
  console.log(`ai-gijiroku app listening on port ${PORT}`);
});
