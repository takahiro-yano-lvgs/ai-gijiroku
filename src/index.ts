import express from "express";
import path from "path";
import multer from "multer";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, "public/uploads");
const AUDIO_DIR = path.join(__dirname, "public/audio");
const SPLIT_AUDIO_DIR = path.join(__dirname, "public/audio_split");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
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

const convertVideoToAudio = async (input_file: string, output_file: string) => {
  return new Promise((resolve, reject) => {
    ffmpeg(input_file)
      .toFormat("mp3")
      .on("end", () => {
        resolve(true);
      })
      .on("error", (err) => {
        reject(err);
      })
      .save(output_file);
  });
};

//20MB以上の音声ファイルを分割
const splitAudio = async (input_file: string, size = 20) => {
  const fileSize = fs.statSync(input_file).size;
  //いくつの音声ファイルに分割するか決定
  const numParts = Math.ceil(fileSize / (size * 1024 * 1024));

  const pathname = path.basename(input_file);
  fs.rmSync(SPLIT_AUDIO_DIR, { recursive: true, force: true });
  fs.mkdirSync(SPLIT_AUDIO_DIR, { recursive: true });

  if (numParts === 1) {
    await new Promise((resolve, reject) => {
      ffmpeg(input_file)
        .on("end", () => resolve(true))
        .on("error", (err) => reject(err))
        .save(`${SPLIT_AUDIO_DIR}/${pathname}`);
    });
    return;
  }

  //音声データの全長を秒単位で取得
  const duration: number = await new Promise((resolve, reject) => {
    ffmpeg(input_file).ffprobe((err, data) => {
      if (err) {
        reject(err);
      } else {
        const duration = data.format.duration;
        if (duration) {
          resolve(duration);
        }
        reject(new Error("Duration is undefined"));
      }
    });
  });

  //音声データを分割
  const partDuration = Math.ceil(duration / numParts);
  const parts = [];
  for (let i = 0; i < numParts; i++) {
    const start = i * partDuration;
    const end = Math.min(start + partDuration, duration);
    const part = ffmpeg(input_file)
      .seekInput(start)
      .duration(end - start)
      .toFormat("mp3");
    parts.push(part);
  }

  //分割した音声データを保存
  await Promise.all(
    parts.map((part, index) =>
      part.save(`${SPLIT_AUDIO_DIR}/${index}-${pathname}`)
    )
  );

  return;
};

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/complete", (req, res) => {
  res.sendFile(path.join(__dirname, "public/complete.html"));
});

app.post("/api/videoes", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).send("No file uploaded");
      return;
    }

    fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const audioFile = path.join(
      AUDIO_DIR,
      req.file.filename.replace(/\.[mM][pP]4$/, ".mp3")
    );
    await convertVideoToAudio(
      path.join(UPLOAD_DIR, req.file.filename),
      audioFile
    );

    await splitAudio(audioFile);

    res.redirect(301, "/complete");
  } catch (error) {
    res.status(500).send(error);
  }
});

app.listen(PORT, () => {
  console.log(`ai-gijiroku app listening on port ${PORT}`);
});
