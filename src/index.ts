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
const MAIL_DIR = path.join(__dirname, "public/mail");
const AUDIO_FORMATS = "wav";
const SLACK_ID_LENGTH = 11;
const SLACK_API_URL = "https://slack.com/api/";
const PORT = 3000;

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/css", express.static(__dirname + "/public/css"));

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

const postSlack = async (userId: string, content: string) => {
  try {
    const response = await axios.post(
      `${SLACK_API_URL}conversations.open`,
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
      `${SLACK_API_URL}chat.postMessage`,
      {
        token: process.env.SLACK_BOT_TOKEN,
        channel: channelId,
        text: content,
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

const convertToText = async () => {
  const audioFiles = fs.readdirSync(AUDIO_DIR);
  const audioFilePath = path.join(AUDIO_DIR, audioFiles[0]);

  clearDir(TRANSCRIPTION_DIR);
  const transcriptionFilePath = path.join(
    TRANSCRIPTION_DIR,
    audioFiles[0].replace(`.${AUDIO_FORMATS}`, ".txt")
  );

  const apiUrl = process.env.AZURE_API_URL as string;

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
};

const setupVertexAi = () => {
  const vertexai = new VertexAI({
    project: process.env.GOOGLE_PROJECT_ID,
    googleAuthOptions: {
      credentials: {
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        quota_project_id: process.env.GOOGLE_PROJECT_ID,
        refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
        type: "authorized_user",
        universe_domain: "googleapis.com",
      },
    },
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

const generateContent = async (inputDir: string, outputDir: string, prompt: string) => {
  const generativeModel = setupVertexAi();

  const inputFiles = fs.readdirSync(inputDir);
  const inputFilePath = path.join(inputDir, inputFiles[0]);
  const inputContent = fs.readFileSync(inputFilePath, "utf8");

  clearDir(outputDir);
  const outputFilePath = path.join(outputDir, inputFiles[0]);

  const request = {
    contents: [
      { role: "user", parts: [{ text: prompt }] },
      { role: "user", parts: [{ text: inputContent }] },
    ],
  };
  const result = await generativeModel.generateContent(request);
  const response = result.response;
  if (response.candidates) {
    const content = response.candidates[0].content.parts[0].text;
    if (!content) {
      throw new Error("コンテンツ生成に失敗しました");
    }
    const formattedContent = markdownToMrkdwn(content);
    fs.writeFileSync(outputFilePath, formattedContent);
  } else {
    throw new Error("コンテンツ生成に失敗しました");
  }
};

const postGijirokuAndMailToSlack = async (userId: string) => {
  const gijirokuFiles = fs.readdirSync(GIJIROKU_DIR);
  const gijirokuFilePath = path.join(GIJIROKU_DIR, gijirokuFiles[0]);
  const gijiroku = fs.readFileSync(gijirokuFilePath, "utf8");

  const mailFiles = fs.readdirSync(MAIL_DIR);
  const mailFilePath = path.join(MAIL_DIR, mailFiles[0]);
  const mail = fs.readFileSync(mailFilePath, "utf8");

  // const transcriptionFile = fs.readdirSync(TRANSCRIPTION_DIR);
  // const transcriptionFilePath = path.join(TRANSCRIPTION_DIR, transcriptionFile[0]);
  // const transcription = fs.readFileSync(transcriptionFilePath, "utf8");

  postSlack(userId, gijiroku);
  postSlack(userId, mail);
  // postSlack(userId, transcription);
};

// 静的サイトはs3にホスティング
app.get("/", (req, res) => {
  // ローカル環境でテストする場合
  res.sendFile(path.join(__dirname, "public/localIndex.html"));
  // 本番環境のエンドポイントを使用する場合
  // res.sendFile(path.join(__dirname, "public/index.html"));
});

app.get("/create-prompt", (req, res) => {
  res.sendFile(path.join(__dirname, "public/createPrompt.html"));
});

app.get("/edit-prompt", (req, res) => {
  res.sendFile(path.join(__dirname, "public/editPrompt.html"));
});

app.get("/complete", (req, res) => {
  res.sendFile(path.join(__dirname, "public/complete.html"));
});

// s3に動画がアップロードされたら実行されるlambda関数
app.post("/api/videos", upload.single("file"), async (req, res) => {
  const { userId, gijirokuPrompt, mailPrompt } = req.body;

  try {
    if (!userId || userId.length !== SLACK_ID_LENGTH) {
      res.status(400).send("ユーザーIDの入力値が不正です");
    }
    res.redirect(301, "/complete");

    await convertVideoToAudio();
    await convertToText();
    await generateContent(TRANSCRIPTION_DIR, GIJIROKU_DIR, gijirokuPrompt);
    await generateContent(GIJIROKU_DIR, MAIL_DIR, mailPrompt);
    await postGijirokuAndMailToSlack(userId);
  } catch (error: unknown) {
    if (error instanceof Error) {
      postSlack(userId, `${error.message}\n再度アップロードしてください`);
    } else {
      postSlack(
        userId,
        `予期せぬエラーが発生しました\n再度アップロードしてください`
      );
    }
  }
});

app.listen(PORT, () => {
  console.log(`ai-gijiroku app listening on port ${PORT}`);
});
