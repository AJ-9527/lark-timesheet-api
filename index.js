// index.js
// 功能：
// - 手机号 + 验证码登录（不接 Twilio，目前直接在日志 + 返回 debug_code）
// - /api/request_code  请求验证码
// - /api/verify_code   验证验证码，生成 session_token
// - /api/timesheet     按日期 + 当前登录人 查询工时
// - /api/people        获取人员列表（管理员用）
// - /api/debug-record  查看一条工时记录原始 fields
// - /api/debug-people  查看一条人员记录原始 fields

const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
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

// ====== 通用：读取 Bitable 记录（fields 用字段名作 key） ======
async function listBitableRecords({ appToken, tableId, filter }) {
  const token = await getTenantAccessToken();
  let pageToken = undefined;
  const allRecords = [];

  do {
    const params = {
      page_size: 500,
    };
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

// ====== 简单的“签名 token”工具（会话 token，不是 Lark 的） ======
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
    return payload; // { personName, expiresAt }
  } catch (e) {
    return null;
  }
}

// ====== 简单的手机验证码存储（内存版） ======
const phoneCodeStore = new Map(); // key: 归一化手机号, value: { code, expiresAt }

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

  const normalizePhone = (p) => String(p).replace(/\D/g, "");
  const target = normalizePhone(phone);
  if (!target) return null;

  for (const r of records) {
    const f = r.fields || {};
    const vPhone = f[phoneField];
    const phoneArr = extractTextValues(vPhone);
    if (!phoneArr.length) continue;
    const empPhone = normalizePhone(phoneArr[0]);
    if (!empPhone) continue;

    if (empPhone === target) {
      const nameArr = extractTextValues(f[nameField]);
      const name = nameArr[0] || null;
      if (!name) return null;
      return {
        name,
        phone: empPhone,
      };
    }
  }

  return null;
}

// ====== 工时查询逻辑 ======

// 工时报表中用于显示/筛选人员的字段名
const TIMESHEET_PERSON_FIELD_NAME =
  process.env.TIMESHEET_PERSON_FIELD_NAME || "人员姓名 NameText";

async function queryTimesheetRecords({ startDate, endDate, person }) {
  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  // 1. 不使用 Lark 端 filter，直接拉全表，再在 Node 中筛选
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
    if (typeof val === "string") {
      return val.slice(0, 10);
    }
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

// ====== 人员列表逻辑 ======

async function queryAllPersonsFromPeopleTable() {
  const appToken = process.env.PEOPLE_APP_TOKEN;
  const tableId = process.env.PEOPLE_TABLE_ID;
  const nameFieldName =
    process.env.PEOPLE_NAME_FIELD || "常用名 Common Name";

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
    const arr = extractTextValues(v);
    arr.forEach((name) => personSet.add(name));
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
    const arr = extractTextValues(v);
    arr.forEach((name) => personSet.add(name));
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
app.get("/ping", (req, res) => {
  res.send("OK");
});

// ====== 请求短信验证码（目前不接 Twilio，只返回 debug_code） ======
app.post("/api/request_code", async (req, res) => {
  try {
    const { phone } = req.body || {};
    if (!phone) {
      return res.status(400).json({ code: 1, msg: "手机号必填" });
    }

    const emp = await findEmployeeByPhone(phone);
    if (!emp) {
      return res
        .status(400)
        .json({ code: 1, msg: "该手机号在员工信息中不存在" });
    }

    const code = String(Math.floor(100000 + Math.random() * 900000));
    setPhoneCode(phone, code);

    // 现在先不接 Twilio，直接打印到日志 & 返回 debug_code 方便测试
    console.log(`【调试】验证码发送给 ${emp.name} (${phone}): ${code}`);

    res.json({
      code: 0,
      msg: "验证码已生成（调试环境），请查看 debug_code 或服务器日志",
      debug_code: code,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 1, msg: "Server error" });
  }
});

// ====== 校验验证码，生成 session_token ======
app.post("/api/verify_code", async (req, res) => {
  try {
    const { phone, code } = req.body || {};
    if (!phone || !code) {
      return res.status(400).json({ code: 1, msg: "手机号和验证码必填" });
    }

    const ok = verifyPhoneCode(phone, code);
    if (!ok) {
      return res.status(400).json({ code: 1, msg: "验证码错误或已过期" });
    }

    const emp = await findEmployeeByPhone(phone);
    if (!emp) {
      return res
        .status(400)
        .json({ code: 1, msg: "员工信息不存在，请联系管理员" });
    }

    const token = createSessionToken(emp.name);

    res.json({
      code: 0,
      msg: "验证通过",
      token,
      personName: emp.name,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ code: 1, msg: "Server error" });
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
    res.json({ code: 0, data: records });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 1, msg: "Server error" });
  }
});

// ====== 人员列表（管理员用） ======
app.get("/api/people", async (req, res) => {
  try {
    const persons = await queryAllPersons();
    res.json({ code: 0, data: persons });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 1, msg: "Server error" });
  }
});

// ====== 调试：工时表的一条记录 ======
app.get("/api/debug-record", async (req, res) => {
  try {
    const appToken = process.env.BITABLE_APP_TOKEN;
    const tableId = process.env.BITABLE_TABLE_ID;
    const records = await listBitableRecords({
      appToken,
      tableId,
      filter: undefined,
    });
    if (!records.length) {
      return res.json({ code: 0, msg: "no records", fields: {} });
    }
    res.json({ code: 0, msg: "ok", fields: records[0].fields || {} });
  } catch (e) {
    console.error("debug-record error", e);
    res.status(500).json({ code: 1, msg: "debug error: " + e.message });
  }
});

// ====== 调试：人员表的一条记录 ======
app.get("/api/debug-people", async (req, res) => {
  try {
    const appToken = process.env.PEOPLE_APP_TOKEN;
    const tableId = process.env.PEOPLE_TABLE_ID;
    if (!appToken || !tableId) {
      return res.json({
        code: 1,
        msg: "PEOPLE_APP_TOKEN or PEOPLE_TABLE_ID not set",
      });
    }
    const records = await listBitableRecords({
      appToken,
      tableId,
      filter: undefined,
    });
    if (!records.length) {
      return res.json({ code: 0, msg: "no records", fields: {} });
    }
    res.json({ code: 0, msg: "ok", fields: records[0].fields || {} });
  } catch (e) {
    console.error("debug-people error", e);
    res
      .status(500)
      .json({ code: 1, msg: "debug people error: " + e.message });
  }
});

// ====== 启动服务 ======
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
