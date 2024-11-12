import express from "express";
import path from "path";
import multer from "multer";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, "public/uploads");
const AUDIO_DIR = path.join(__dirname, "public/audio");

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
});

const upload = multer({
  storage,
  fileFilter(req, file, cb) {
    if (file.mimetype === "video/mp4") {
      cb(null, true);
      return;
    } else {
      cb(new Error("Invalid file type"));
    }
  },
});

const convert_video_to_audio = (input_file: string, output_file: string) => {
  ffmpeg(input_file).toFormat("mp3").save(output_file);
};

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.post("/api/videoes", upload.single("file"), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).send("No file uploaded");
      return;
    }

    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    convert_video_to_audio(
      path.join(UPLOAD_DIR, req.file.filename),
      path.join(AUDIO_DIR, req.file.filename.replace(".mp4", ".mp3"))
    );

    res.redirect(301, "/");
  } catch (error) {
    res.status(500).send(error);
  }
});

app.listen(PORT, () => {
  console.log(`ai-gijiroku app listening on port ${PORT}`);
});
