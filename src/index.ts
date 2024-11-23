import fs from "fs";
import path from "path";

import axios from "axios";
import express from "express";
import ffmpeg from "fluent-ffmpeg";
import FormData from "form-data";
import multer from "multer";
import { VertexAI } from "@google-cloud/vertexai";
import "dotenv/config";

const UPLOAD_DIR = path.join(__dirname, "public/uploads");
const AUDIO_DIR = path.join(__dirname, "public/audio");
const TRANSCRIPTION_DIR = path.join(__dirname, "public/transcription");
const GIJIROKU_DIR = path.join(__dirname, "public/gijiroku");
const PROMPT_DIR = path.join(__dirname, "public/prompt");
const MAIL_DIR = path.join(__dirname, "public/mail");
const PORT = 3000;

const app = express();
const serviceKey = process.env.AZURE_API_KEY as string;
const serviceRegion = process.env.AZURE_REGION as string;

const vertexai = new VertexAI({
  project: process.env.GOOGLE_PROJECT_ID,
});

const generativeModel = vertexai.getGenerativeModel({
  model: "gemini-1.5-pro",
  systemInstruction: {
    role: "system",
    parts: [
      {
        text: `あなたは最適な商談の議事録やお礼メールを作成できる人です。メッセージに対して、分かりやすく構造化された形で応答してください。`,
      },
    ],
  },
});

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
      .audioFrequency(16000)
      .audioChannels(1)
      .audioCodec("pcm_s16le")
      .toFormat("wav")
      .on("end", () => {
        resolve(true);
      })
      .on("error", (err) => {
        reject(err);
      })
      .save(output_file);
  });
};

const convertToText = async (originAudioFile: string) => {
  const files = fs.readdirSync(AUDIO_DIR);
  fs.rmSync(TRANSCRIPTION_DIR, { recursive: true, force: true });
  fs.mkdirSync(TRANSCRIPTION_DIR, { recursive: true });
  const audioFile = path.join(AUDIO_DIR, files[0]);

  const transcriptionFile = path.join(
    TRANSCRIPTION_DIR,
    path.basename(originAudioFile).replace(".wav", ".txt")
  );

  const apiUrl = `https://${serviceRegion}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`;
  const formData = new FormData();
  const audioData = fs.readFileSync(audioFile);
  formData.append("audio", audioData, {
    filename: path.basename(audioFile),
  });
  formData.append(
    "definition",
    JSON.stringify({
      locales: ["ja-JP"],
    }),
    {
      filename: "definition.json",
    }
  );

  try {
    const response = await axios.post(apiUrl, formData, {
      headers: {
        "Content-Type": "multipart/form-data",
        "Ocp-Apim-Subscription-Key": serviceKey,
      },
      maxBodyLength: Infinity,
    });

    for await (const item of response.data.phrases) {
      fs.appendFileSync(transcriptionFile, item.text + "\n", "utf8");
    }
  } catch (error: any) {
    throw new Error(error.message);
  }
};

const markdownToMrkdwn = (markdownText: string) => {
  let mrkdwnText = markdownText.replace(/#+\s/g, "");

  mrkdwnText = mrkdwnText.replace(/\n\*\s(.*?)/g, "\n- $1");
  
  mrkdwnText = mrkdwnText.replace(/\*\*(.*?)\*\*/g, "*$1*");

  return mrkdwnText;
};

const convertTranscriptionToGijiroku = async (originAudioFile: string) => {
  const file = fs.readdirSync(TRANSCRIPTION_DIR);
  fs.rmSync(GIJIROKU_DIR, { recursive: true, force: true });
  fs.mkdirSync(GIJIROKU_DIR, { recursive: true });

  const gijirokuFile = path.join(
    GIJIROKU_DIR,
    path.basename(originAudioFile).replace(".wav", ".txt")
  );

  const promptFile = fs.readFileSync(
    `${PROMPT_DIR}/gijiroku_prompt.txt`,
    "utf8"
  );
  const transcriptionFile = path.join(TRANSCRIPTION_DIR, file[0]);
  const transcription = fs.readFileSync(transcriptionFile, "utf8");

  const request = {
    contents: [
      { role: "user", parts: [{ text: promptFile }] },
      { role: "user", parts: [{ text: transcription }] },
    ],
  };
  const result = await generativeModel.generateContent(request);
  const response = result.response;
  if (response.candidates) {
    const gijiroku = response.candidates[0].content.parts[0].text;
    if (!gijiroku) {
      throw new Error("議事録の作成に失敗しました");
    }
    const formattedGijiroku = markdownToMrkdwn(gijiroku);
    fs.writeFileSync(gijirokuFile, formattedGijiroku);
  }
};

const createMail = async (audioFile: string) => {
  const file = fs.readdirSync(GIJIROKU_DIR);
  fs.rmSync(MAIL_DIR, { recursive: true, force: true });
  fs.mkdirSync(MAIL_DIR, { recursive: true });

  const mailFile = path.join(MAIL_DIR, file[0]);
  const promptFile = fs.readFileSync(`${PROMPT_DIR}/mail_prompt.txt`, "utf8");
  const gijirokuFile = path.join(GIJIROKU_DIR, file[0]);
  const gijiroku = fs.readFileSync(gijirokuFile, "utf8");

  const request = {
    contents: [
      { role: "user", parts: [{ text: promptFile }] },
      { role: "user", parts: [{ text: gijiroku }] },
    ],
  };
  const result = await generativeModel.generateContent(request);
  const response = result.response;
  if (response.candidates) {
    const mail = response.candidates[0].content.parts[0].text;
    if (!mail) {
      throw new Error("メールの作成に失敗しました");
    }
    const formattedMail = markdownToMrkdwn(mail);
    fs.writeFileSync(mailFile, formattedMail);
  }
};

const postGijirokuAndMailToSlack = async (audioFile: string, userId: string) => {
  const gijiroku = fs.readFileSync(
    path.join(GIJIROKU_DIR, path.basename(audioFile).replace(".wav", ".txt")),
    "utf8"
  );
  const mail = fs.readFileSync(
    path.join(MAIL_DIR, path.basename(audioFile).replace(".wav", ".txt")),
    "utf8"
  );

  const response = await axios.post(
    "https://slack.com/api/conversations.open",
    {
      token: process.env.SLACK_BOT_TOKEN,
      users: userId,
    },
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    }
  );
  const channelId = response.data.channel.id;

  await axios.post(
    "https://slack.com/api/chat.postMessage",
    {
      token: process.env.SLACK_BOT_TOKEN,
      channel: channelId,
      text: gijiroku,
    },
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    }
  );

  await axios.post(
    "https://slack.com/api/chat.postMessage",
    {
      token: process.env.SLACK_BOT_TOKEN,
      channel: channelId,
      text: mail,
    },
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    }
  );
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

    const userId = req.body.userId;
    if (!userId) {
      res.status(400).send("No user ID provided");
      return;
    }

    fs.rmSync(AUDIO_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUDIO_DIR, { recursive: true });
    const audioFile = path.join(
      AUDIO_DIR,
      req.file.filename.replace(/\.[mM][pP]4$/, ".wav")
    );

    await convertVideoToAudio(
      path.join(UPLOAD_DIR, req.file.filename),
      audioFile
    );
    await convertToText(audioFile);
    await convertTranscriptionToGijiroku(audioFile);
    await createMail(audioFile);
    await postGijirokuAndMailToSlack(audioFile, userId);

    res.redirect(301, "/complete");
  } catch (error: unknown) {
    if (error instanceof Error) {
      res.status(500).send(error.message);
    } else {
      res.status(500).send("予期せぬエラー");
    }
  }
});

app.listen(PORT, () => {
  console.log(`ai-gijiroku app listening on port ${PORT}`);
});
