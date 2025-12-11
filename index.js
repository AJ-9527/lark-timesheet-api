// index.js
// Lark Bitable 工时查询服务（按字段名取值的简化版本）
// - /api/timesheet  按日期/人员查询打卡记录
// - /api/people     获取人员列表（优先从人员表读取）
// - /api/debug-record  调试：输出一条工时记录的原始 fields
// - /api/debug-people  调试：输出一条人员记录的原始 fields

const express = require("express");
const axios = require("axios");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// 静态页面
app.use(express.static("public"));

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

// ====== 通用：读取 Bitable 记录（fields 用“字段名”作 key） ======
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

// ====== 工时查询逻辑 ======

// 工时报表中用于显示/筛选人员的字段名
const TIMESHEET_PERSON_FIELD_NAME =
  process.env.TIMESHEET_PERSON_FIELD_NAME || "人员姓名 NameText";

async function queryTimesheetRecords({ startDate, endDate, person }) {
  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  // 1. 不带任何筛选，从 Lark 一次性把记录都拉下来
  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: undefined,
  });

  // 2. 把传进来的日期字符串先记住（格式：YYYY-MM-DD）
  const startStr = startDate || null;
  const endStr = endDate || null;

  // 工具：把日期字段的值转成 YYYY-MM-DD 字符串
  const toDateStr = (val) => {
    if (typeof val === "number") {
      const d = new Date(val);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dd}`;
    }
    if (typeof val === "string") {
      // 如果本来就是 "2025-01-10" 或 "2025-01-10 08:00" 之类
      return val.slice(0, 10);
    }
    return "";
  };

  // 3. 先按日期 / 人员在 Node.js 里过滤
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

  // 4. 再把字段整理成前端需要的结构
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

// 1）优先从“人员表”读取
async function queryAllPersonsFromPeopleTable() {
  const appToken = process.env.PEOPLE_APP_TOKEN;
  const tableId = process.env.PEOPLE_TABLE_ID;
  const nameFieldName = process.env.PEOPLE_NAME_FIELD || "姓名";

  if (!appToken || !tableId) return null; // 未配置则不使用

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

// 2）否则从工时报表汇总
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
  // 1）优先尝试人员表
  try {
    const fromPeople = await queryAllPersonsFromPeopleTable();
    if (fromPeople && fromPeople.length) return fromPeople;
  } catch (e) {
    console.warn("queryAllPersonsFromPeopleTable failed:", e.message);
  }

  // 2）否则从工时报表汇总
  return await queryAllPersonsFromTimesheet();
}

// ====== 健康检查 ======
app.get("/ping", (req, res) => {
  res.send("OK");
});

// ====== API：工时查询 ======
app.get("/api/timesheet", async (req, res) => {
  try {
    const { start_date, end_date, person } = req.query;
    const records = await queryTimesheetRecords({
      startDate: start_date,
      endDate: end_date,
      person,
    });
    res.json({ code: 0, data: records });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 1, msg: "Server error" });
  }
});

// ====== API：人员列表 ======
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
