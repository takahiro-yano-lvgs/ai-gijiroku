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
const GIJIROKU_PROMPT_DIR = path.join(__dirname, "public/gijiroku_prompt");
const MAIL_PROMPT_DIR = path.join(__dirname, "public/mail_prompt");
const MAIL_DIR = path.join(__dirname, "public/mail");
const AUDIO_FORMATS = "wav";
const PORT = 3000;

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const clearDir = (dir: string) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  } catch (error) {
    throw new Error("ディレクトリのクリアに失敗しました");
  }
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    clearDir(UPLOAD_DIR);
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
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
      cb(new Error("動画ファイル形式がmp4でありません"));
    }
  },
});

const convertVideoToAudio = async () => {
  const videoFiles = fs.readdirSync(UPLOAD_DIR);
  const videoFilePath = path.join(UPLOAD_DIR, videoFiles[0]);

  clearDir(AUDIO_DIR);
  const audioFilePath = path.join(
    AUDIO_DIR,
    videoFiles[0].replace(/\.[mM][pP]4$/, `.${AUDIO_FORMATS}`)
  );

  return new Promise((resolve, reject) => {
    ffmpeg(videoFilePath)
      .audioFrequency(16000)
      .audioChannels(1)
      .toFormat(AUDIO_FORMATS)
      .save(audioFilePath)
      .on("end", () => {
        resolve(true);
      })
      .on("error", (err) => {
        reject(err);
      });
  });
};

const convertToText = async () => {
  const audioFiles = fs.readdirSync(AUDIO_DIR);
  const audioFilePath = path.join(AUDIO_DIR, audioFiles[0]);

  clearDir(TRANSCRIPTION_DIR);
  const transcriptionFilePath = path.join(
    TRANSCRIPTION_DIR,
    audioFiles[0].replace(`.${AUDIO_FORMATS}`, ".txt")
  );

  const serviceRegion = process.env.AZURE_REGION;
  const apiUrl = `https://${serviceRegion}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`;

  const formData = new FormData();
  const audioData = fs.readFileSync(audioFilePath);
  formData.append("audio", audioData, {
    filename: audioFiles[0],
  });
  formData.append(
    "definition",
    JSON.stringify({
      locales: ["ja-JP"],
    })
  );

  try {
    const serviceKey = process.env.AZURE_API_KEY;
    const response = await axios.post(apiUrl, formData, {
      headers: {
        "Content-Type": "multipart/form-data",
        "Ocp-Apim-Subscription-Key": serviceKey,
      },
    });

    for (const phrase of response.data.phrases) {
      fs.appendFileSync(transcriptionFilePath, phrase.text + "\n");
    }
  } catch (error: unknown) {
    if (error instanceof Error) {
      throw new Error(error.message);
    } else {
      throw new Error("予期せぬエラー");
    }
  }
};

const setupVertexAi = () => {
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

  return generativeModel;
};

const markdownToMrkdwn = (markdownText: string) => {
  let mrkdwnText = markdownText.replace(/#+\s/g, "");

  mrkdwnText = mrkdwnText.replace(/\n\*\s(.*?)/g, "\n- $1");

  mrkdwnText = mrkdwnText.replace(/\*\*(.*?)\*\*/g, "*$1*");

  return mrkdwnText;
};

const convertTranscriptionToGijiroku = async () => {
  const generativeModel = setupVertexAi();

  const transcriptionFiles = fs.readdirSync(TRANSCRIPTION_DIR);
  const transcriptionFilePath = path.join(
    TRANSCRIPTION_DIR,
    transcriptionFiles[0]
  );
  const transcription = fs.readFileSync(transcriptionFilePath, "utf8");

  const promptFiles = fs.readdirSync(GIJIROKU_PROMPT_DIR);
  const promptFilePath = path.join(GIJIROKU_PROMPT_DIR, promptFiles[0]);
  const prompt = fs.readFileSync(promptFilePath, "utf8");

  clearDir(GIJIROKU_DIR);
  const gijirokuFilePath = path.join(GIJIROKU_DIR, transcriptionFiles[0]);

  const request = {
    contents: [
      { role: "user", parts: [{ text: prompt }] },
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
    fs.writeFileSync(gijirokuFilePath, formattedGijiroku);
  } else {
    throw new Error("議事録の作成に失敗しました");
  }
};

const createMail = async () => {
  const generativeModel = setupVertexAi();

  const gijirokuFiles = fs.readdirSync(GIJIROKU_DIR);
  const gijirokuFile = path.join(GIJIROKU_DIR, gijirokuFiles[0]);
  const gijiroku = fs.readFileSync(gijirokuFile, "utf8");

  const promptFiles = fs.readdirSync(MAIL_PROMPT_DIR);
  const promptFilePath = path.join(MAIL_PROMPT_DIR, promptFiles[0]);
  const prompt = fs.readFileSync(promptFilePath, "utf8");

  clearDir(MAIL_DIR);
  const mailFile = path.join(MAIL_DIR, gijirokuFiles[0]);

  const request = {
    contents: [
      { role: "user", parts: [{ text: prompt }] },
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
  } else {
    throw new Error("メールの作成に失敗しました");
  }
};

const postGijirokuAndMailToSlack = async (userId: string) => {
  const gijirokuFiles = fs.readdirSync(GIJIROKU_DIR);
  const gijirokuFilePath = path.join(GIJIROKU_DIR, gijirokuFiles[0]);
  const gijiroku = fs.readFileSync(gijirokuFilePath, "utf8");

  const mailFiles = fs.readdirSync(MAIL_DIR);
  const mailFilePath = path.join(MAIL_DIR, mailFiles[0]);
  const mail = fs.readFileSync(mailFilePath, "utf8");

  try {
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
  } catch (error: unknown) {
    if (error instanceof Error) {
      console.log(error.message);
    } else {
      console.log("予期せぬエラーが発生しました");
    }
  }
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
      throw new Error("ファイルがアップロードされていません");
    }

    const userId = req.body.userId;
    if (!userId) {
      throw new Error("ユーザーIDが入力されていません");
    }

    await convertVideoToAudio();
    await convertToText();
    await convertTranscriptionToGijiroku();
    await createMail();
    await postGijirokuAndMailToSlack(userId);

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
