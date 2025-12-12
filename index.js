// index.js
// 功能：
// - Twilio 短信验证码（中英双语）
// - 手机号格式：支持 6041234567，自动转成 +16041234567（加拿大）
// - /api/request_code  请求短信验证码（后端防刷：60秒）
// - /api/verify_code   验证验证码，生成 session_token（4小时有效）
// - /api/timesheet     按日期 + 当前登录人 查询工时（session_token 强制只查本人）
// - /api/people        获取人员列表（可选）
// - /api/debug-record  工时表任意一条 fields（调试）
// - /api/debug-people  人员表任意一条 fields（调试）
//
// 需要的环境变量：
// - LARK_APP_ID, LARK_APP_SECRET
// - BITABLE_APP_TOKEN, BITABLE_TABLE_ID
// - PEOPLE_APP_TOKEN, PEOPLE_TABLE_ID, PEOPLE_NAME_FIELD (例如：常用名 Common Name)
// - EMPLOYEE_PHONE_FIELD (例如：手机号码 Phone)  // 用于手机号->姓名匹配
// - SESSION_SECRET
// - TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM (+1xxxxxxx)

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const twilio = require("twilio");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// 静态页面 & JSON 解析
app.use(express.static("public"));
app.use(express.json());

// ====== Lark tenant_access_token 缓存 ======
let cachedToken = null;
let tokenExpireAt = 0; // ms

async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpireAt) return cachedToken;

  const resp = await axios.post(
    "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    },
    { headers: { "Content-Type": "application/json" } }
  );

  if (resp.data.code !== 0) {
    console.error("getTenantAccessToken error:", resp.data);
    throw new Error("Failed to get tenant_access_token: " + resp.data.msg);
  }

  cachedToken = resp.data.tenant_access_token;
  const expireSeconds = resp.data.expire || 3600;
  tokenExpireAt = now + (expireSeconds - 60) * 1000;
  return cachedToken;
}

// ====== 通用：读取 Bitable 记录 ======
async function listBitableRecords({ appToken, tableId, filter }) {
  const token = await getTenantAccessToken();
  let pageToken = undefined;
  const allRecords = [];

  do {
    const params = { page_size: 500 };
    if (filter) params.filter = filter;
    if (pageToken) params.page_token = pageToken;

    const resp = await axios.get(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params,
      }
    );

    if (resp.data.code !== 0) {
      console.error("listBitableRecords error:", resp.data);
      throw new Error("Failed to list records: " + resp.data.msg);
    }

    const data = resp.data.data || {};
    const items = data.items || [];
    allRecords.push(...items);

    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);

  return allRecords;
}

// 提取各种可能格式中的文本值：字符串 / 对象 / 数组
function extractTextValues(value) {
  const result = [];

  const addIfGood = (s) => {
    if (typeof s === "string") {
      const t = s.trim();
      if (t) result.push(t);
    }
  };

  if (typeof value === "string") {
    addIfGood(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => {
      if (typeof item === "string") addIfGood(item);
      else if (item && typeof item === "object") {
        if (item.text) addIfGood(String(item.text));
        if (item.name) addIfGood(String(item.name));
      }
    });
  } else if (value && typeof value === "object") {
    if (value.text) addIfGood(String(value.text));
    if (value.name) addIfGood(String(value.name));
  }

  return result;
}

// ====== 会话 token（非 Lark token）=====
function createSessionToken(personName) {
  const secret = process.env.SESSION_SECRET || "default_secret";
  const expiresAt = Date.now() + 1000 * 60 * 60 * 4; // 4 小时有效
  const payload = JSON.stringify({ personName, expiresAt });
  const payloadBase64 = Buffer.from(payload).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(payloadBase64)
    .digest("base64url");
  return `${payloadBase64}.${sig}`;
}

function parseSessionToken(token) {
  if (!token) return null;
  const secret = process.env.SESSION_SECRET || "default_secret";
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadBase64, sig] = parts;

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payloadBase64)
    .digest("base64url");
  if (sig !== expectedSig) return null;

  try {
    const payload = JSON.parse(
      Buffer.from(payloadBase64, "base64url").toString()
    );
    if (!payload.personName || !payload.expiresAt) return null;
    if (Date.now() > payload.expiresAt) return null;
    return payload;
  } catch {
    return null;
  }
}

// ====== 验证码存储（内存版） ======
const phoneCodeStore = new Map(); // key: digits phone -> { code, expiresAt }

// 5 分钟有效（跟短信文案一致）
function setPhoneCode(phone, code, ttlMs = 5 * 60 * 1000) {
  const key = String(phone).replace(/\D/g, "");
  const expiresAt = Date.now() + ttlMs;
  phoneCodeStore.set(key, { code, expiresAt });
}

function verifyPhoneCode(phone, code) {
  const key = String(phone).replace(/\D/g, "");
  const item = phoneCodeStore.get(key);
  if (!item) return false;
  if (Date.now() > item.expiresAt) {
    phoneCodeStore.delete(key);
    return false;
  }
  if (item.code !== code) return false;
  phoneCodeStore.delete(key);
  return true;
}

// ====== 后端 60 秒防刷（即使前端绕过也不行）=====
const lastSendAt = new Map(); // key: digits phone -> timestamp
function canSendNow(phone, windowMs = 60 * 1000) {
  const key = String(phone).replace(/\D/g, "");
  const last = lastSendAt.get(key) || 0;
  const now = Date.now();
  if (now - last < windowMs) return { ok: false, waitMs: windowMs - (now - last) };
  lastSendAt.set(key, now);
  return { ok: true, waitMs: 0 };
}

// ====== Twilio 短信 ======
const twilioClient =
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN
    ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
    : null;

/**
 * 规范化加拿大手机号为 E.164
 * - "6041234567" => "+16041234567"
 * - "+16041234567" => "+16041234567"
 */
function normalizeCanadaPhone(phone) {
  if (!phone) return null;
  const p = String(phone).trim();

  if (/^\+1\d{10}$/.test(p)) return p;
  if (/^\d{10}$/.test(p)) return `+1${p}`;

  // 可按需扩展：如果有人填了 "1xxxxxxxxxx" 也给它转一下
  if (/^1\d{10}$/.test(p)) return `+${p}`;

  return null;
}

async function sendSmsTwilio(toE164Phone, code) {
  if (!twilioClient) throw new Error("Twilio not configured");
  const from = process.env.TWILIO_FROM;
  if (!from) throw new Error("TWILIO_FROM not set");

  const body =
`【Lumi HVAC】
验证码 Verification Code: ${code}
5分钟内有效 · Valid for 5 minutes`;

  return await twilioClient.messages.create({
    to: toE164Phone,
    from,
    body,
  });
}

// ====== 员工表：根据手机号查员工姓名 ======
async function findEmployeeByPhone(phone) {
  if (!phone) return null;

  const appToken =
    process.env.EMPLOYEE_APP_TOKEN || process.env.PEOPLE_APP_TOKEN;
  const tableId =
    process.env.EMPLOYEE_TABLE_ID || process.env.PEOPLE_TABLE_ID;

  const nameField =
    process.env.EMPLOYEE_NAME_FIELD ||
    process.env.PEOPLE_NAME_FIELD ||
    "常用名 Common Name";

  const phoneField = process.env.EMPLOYEE_PHONE_FIELD || "手机号码 Phone";

  if (!appToken || !tableId) return null;

  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: undefined,
  });

  const normalizeDigits = (p) => String(p).replace(/\D/g, "");
  const target = normalizeDigits(phone);
  if (!target) return null;

  for (const r of records) {
    const f = r.fields || {};
    const vPhone = f[phoneField];
    const phoneArr = extractTextValues(vPhone);
    if (!phoneArr.length) continue;

    const empPhoneDigits = normalizeDigits(phoneArr[0]);
    if (!empPhoneDigits) continue;

    if (empPhoneDigits === target) {
      const nameArr = extractTextValues(f[nameField]);
      const name = nameArr[0] || null;
      if (!name) return null;
      return { name, phone: empPhoneDigits };
    }
  }

  return null;
}

// ====== 工时查询 ======
const TIMESHEET_PERSON_FIELD_NAME =
  process.env.TIMESHEET_PERSON_FIELD_NAME || "人员姓名 NameText";

async function queryTimesheetRecords({ startDate, endDate, person }) {
  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: undefined,
  });

  const startStr = startDate || null;
  const endStr = endDate || null;

  const toDateStr = (val) => {
    if (typeof val === "number") {
      const d = new Date(val);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    }
    if (typeof val === "string") return val.slice(0, 10);
    return "";
  };

  const filtered = records.filter((r) => {
    const f = r.fields || {};
    const recordDateStr = toDateStr(f["日期 Date"]);

    if (startStr && recordDateStr && recordDateStr < startStr) return false;
    if (endStr && recordDateStr && recordDateStr > endStr) return false;

    if (person) {
      const personVal =
        f[TIMESHEET_PERSON_FIELD_NAME] ||
        f["人员姓名 NameText"] ||
        f["人员 Applicant"];
      const names = extractTextValues(personVal);
      if (!names.includes(person)) return false;
    }

    return true;
  });

  const normalize = (v) => {
    const arr = extractTextValues(v);
    if (arr.length) return arr.join(", ");
    if (Array.isArray(v)) return v.join(", ");
    if (v === null || v === undefined) return "";
    return v;
  };

  return filtered.map((r) => {
    const f = r.fields || {};
    const personVal =
      f[TIMESHEET_PERSON_FIELD_NAME] ||
      f["人员姓名 NameText"] ||
      f["人员 Applicant"];

    return {
      date: toDateStr(f["日期 Date"]),
      project: normalize(f["项目 Project"]),
      startTime: normalize(f["开工时间 Start Time"]),
      endTime: normalize(f["结束时间 End Time"]),
      person: normalize(personVal),
      hours: Number(f["工时"] || 0),
    };
  });
}

// ====== 人员列表（可选） ======
async function queryAllPersonsFromPeopleTable() {
  const appToken = process.env.PEOPLE_APP_TOKEN;
  const tableId = process.env.PEOPLE_TABLE_ID;
  const nameFieldName = process.env.PEOPLE_NAME_FIELD || "常用名 Common Name";

  if (!appToken || !tableId) return null;

  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: undefined,
  });

  const personSet = new Set();
  for (const r of records) {
    const f = r.fields || {};
    const v = f[nameFieldName];
    extractTextValues(v).forEach((name) => personSet.add(name));
  }
  return Array.from(personSet).sort();
}

async function queryAllPersonsFromTimesheet() {
  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: undefined,
  });

  const personSet = new Set();
  for (const r of records) {
    const f = r.fields || {};
    const v =
      f[TIMESHEET_PERSON_FIELD_NAME] ||
      f["人员姓名 NameText"] ||
      f["人员 Applicant"];
    extractTextValues(v).forEach((name) => personSet.add(name));
  }
  return Array.from(personSet).sort();
}

async function queryAllPersons() {
  try {
    const fromPeople = await queryAllPersonsFromPeopleTable();
    if (fromPeople && fromPeople.length) return fromPeople;
  } catch (e) {
    console.warn("queryAllPersonsFromPeopleTable failed:", e.message);
  }
  return await queryAllPersonsFromTimesheet();
}

// ====== 健康检查 ======
app.get("/ping", (req, res) => res.send("OK"));

// ====== 请求验证码（Twilio） ======
app.post("/api/request_code", async (req, res) => {
  try {
    // 同时支持 body / query，方便调试
    const bodyPhone = (req.body && req.body.phone) || (req.body && req.body.Phone) || "";
    const queryPhone = (req.query && req.query.phone) || "";
    const phone = String(bodyPhone || queryPhone || "").trim();

    if (!phone) {
      return res.status(400).json({ code: 1, msg: "手机号必填 / Phone is required" });
    }

    // 后端防刷 60 秒
    const throttle = canSendNow(phone, 60 * 1000);
    if (!throttle.ok) {
      const sec = Math.ceil(throttle.waitMs / 1000);
      return res.status(429).json({
        code: 1,
        msg: `请稍后再试（${sec}s） / Please wait (${sec}s)`,
      });
    }

    // 员工校验：手机号必须存在于员工表
    const emp = await findEmployeeByPhone(phone);
    if (!emp) {
      return res.status(400).json({
        code: 1,
        msg: "该手机号在员工信息中不存在 / Phone not found in employee records",
      });
    }

    // 规范化为 E.164（+1...）用于 Twilio 发送
    const e164 = normalizeCanadaPhone(phone);
    if (!e164) {
      return res.status(400).json({
        code: 1,
        msg: "手机号格式不正确（应为10位加拿大号码）/ Invalid phone format",
      });
    }

    // 生成验证码 & 保存（用原 phone 的 digits 当 key，verify 也用同样规则）
    const code = String(Math.floor(100000 + Math.random() * 900000));
    setPhoneCode(phone, code);

    // 发送短信
    await sendSmsTwilio(e164, code);

    return res.json({
      code: 0,
      msg: "验证码已发送 / Verification code sent",
    });
  } catch (e) {
    console.error("request_code error:", e);
    return res.status(500).json({
      code: 1,
      msg: "短信发送失败 / Failed to send SMS",
    });
  }
});

// ====== 校验验证码，生成 session_token ======
app.post("/api/verify_code", async (req, res) => {
  try {
    const phone = (req.body && (req.body.phone || req.body.Phone)) || "";
    const code = (req.body && req.body.code) || "";

    if (!phone || !code) {
      return res.status(400).json({ code: 1, msg: "手机号和验证码必填 / Phone and code required" });
    }

    const ok = verifyPhoneCode(phone, String(code).trim());
    if (!ok) {
      return res.status(400).json({ code: 1, msg: "验证码错误或已过期 / Invalid or expired code" });
    }

    const emp = await findEmployeeByPhone(phone);
    if (!emp) {
      return res.status(400).json({ code: 1, msg: "员工信息不存在 / Employee not found" });
    }

    const token = createSessionToken(emp.name);

    return res.json({
      code: 0,
      msg: "验证通过 / Verified",
      token,
      personName: emp.name,
    });
  } catch (e) {
    console.error("verify_code error:", e);
    return res.status(500).json({ code: 1, msg: "Server error" });
  }
});

// ====== 工时查询 ======
app.get("/api/timesheet", async (req, res) => {
  try {
    const { start_date, end_date, person, session_token } = req.query;

    let effectivePerson = person;

    // 如果带了 session_token，就强制只查 token 里的这个人
    if (session_token) {
      const payload = parseSessionToken(session_token);
      if (payload && payload.personName) {
        effectivePerson = payload.personName;
      }
    }

    const records = await queryTimesheetRecords({
      startDate: start_date,
      endDate: end_date,
      person: effectivePerson,
    });

    return res.json({ code: 0, data: records });
  } catch (err) {
    console.error("timesheet error:", err);
    return res.status(500).json({ code: 1, msg: "Server error" });
  }
});

// ====== 人员列表（可选） ======
app.get("/api/people", async (req, res) => {
  try {
    const persons = await queryAllPersons();
    return res.json({ code: 0, data: persons });
  } catch (err) {
    console.error("people error:", err);
    return res.status(500).json({ code: 1, msg: "Server error" });
  }
});

// ====== 调试：工时表的一条记录 ======
app.get("/api/debug-record", async (req, res) => {
  try {
    const appToken = process.env.BITABLE_APP_TOKEN;
    const tableId = process.env.BITABLE_TABLE_ID;
    const records = await listBitableRecords({ appToken, tableId, filter: undefined });
    if (!records.length) return res.json({ code: 0, msg: "no records", fields: {} });
    return res.json({ code: 0, msg: "ok", fields: records[0].fields || {} });
  } catch (e) {
    console.error("debug-record error", e);
    return res.status(500).json({ code: 1, msg: "debug error: " + e.message });
  }
});

// ====== 调试：人员表的一条记录 ======
app.get("/api/debug-people", async (req, res) => {
  try {
    const appToken = process.env.PEOPLE_APP_TOKEN;
    const tableId = process.env.PEOPLE_TABLE_ID;
    if (!appToken || !tableId) {
      return res.json({ code: 1, msg: "PEOPLE_APP_TOKEN or PEOPLE_TABLE_ID not set" });
    }

    const records = await listBitableRecords({ appToken, tableId, filter: undefined });
    if (!records.length) return res.json({ code: 0, msg: "no records", fields: {} });

    return res.json({ code: 0, msg: "ok", fields: records[0].fields || {} });
  } catch (e) {
    console.error("debug-people error", e);
    return res.status(500).json({ code: 1, msg: "debug people error: " + e.message });
  }
});

// ====== 启动服务 ======
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
