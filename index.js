// index.js
// Lark Bitable 工时查询服务（基于 field_id 的稳定实现）
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

// ====== 字段元信息缓存：根据字段名找到 field_id ======
/**
 * cache 结构：
 * {
 *   "appToken:tableId": {
 *      byName: { "字段名": { field_id, field_name, ... } },
 *      byId:   { "fldxxxx": { field_id, field_name, ... } }
 *   }
 * }
 */
const fieldMetaCache = {};

async function getFieldMeta(appToken, tableId) {
  const cacheKey = `${appToken}:${tableId}`;
  if (fieldMetaCache[cacheKey]) return fieldMetaCache[cacheKey];

  const token = await getTenantAccessToken();
  let pageToken = undefined;
  const items = [];

  do {
    const params = { page_size: 500 };
    if (pageToken) params.page_token = pageToken;

    const resp = await axios.get(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
      {
        headers: { Authorization: `Bearer ${token}` },
        params,
      }
    );

    if (resp.data.code !== 0) {
      console.error("getFieldMeta error:", resp.data);
      throw new Error("Failed to list fields: " + resp.data.msg);
    }

    const data = resp.data.data || {};
    (data.items || []).forEach((f) => items.push(f));

    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);

  const byName = {};
  const byId = {};
  items.forEach((f) => {
    byName[f.field_name] = f;
    byId[f.field_id] = f;
  });

  const meta = { byName, byId };
  fieldMetaCache[cacheKey] = meta;
  return meta;
}

async function getFieldIdByName(appToken, tableId, fieldName) {
  const meta = await getFieldMeta(appToken, tableId);
  const info = meta.byName[fieldName];
  if (!info) {
    console.warn(`Field name not found: ${fieldName} in table ${tableId}`);
    return null;
  }
  return info.field_id;
}

// ====== 通用：读取 Bitable 记录（fields 用 field_id 作 key） ======
async function listBitableRecords({ appToken, tableId, filter }) {
  const token = await getTenantAccessToken();
  let pageToken = undefined;
  const allRecords = [];

  do {
    const params = {
      page_size: 500,
      // 不使用 field_names:true，返回值以 field_id 为 key
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

// ====== 工时查询逻辑 ======

// 你工时报表中用于显示/筛选人员的字段名（通常是“人员姓名 NameText”）
const TIMESHEET_PERSON_FIELD_NAME =
  process.env.TIMESHEET_PERSON_FIELD_NAME || "人员姓名 NameText";

// 为打卡表预先解析一次各字段的 field_id
let timesheetFieldIdsPromise = null;
async function getTimesheetFieldIds() {
  if (timesheetFieldIdsPromise) return timesheetFieldIdsPromise;

  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  timesheetFieldIdsPromise = (async () => {
    const dateId = await getFieldIdByName(appToken, tableId, "日期 Date");
    const projectId = await getFieldIdByName(appToken, tableId, "项目 Project");
    const startId = await getFieldIdByName(
      appToken,
      tableId,
      "开工时间 Start Time"
    );
    const endId = await getFieldIdByName(
      appToken,
      tableId,
      "结束时间 End Time"
    );
    const hoursId = await getFieldIdByName(appToken, tableId, "工时");
    const personNameId = await getFieldIdByName(
      appToken,
      tableId,
      TIMESHEET_PERSON_FIELD_NAME
    );

    return {
      dateId,
      projectId,
      startId,
      endId,
      hoursId,
      personNameId,
    };
  })();

  return timesheetFieldIdsPromise;
}

// 工时查询
async function queryTimesheetRecords({ startDate, endDate, person }) {
  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  // 筛选条件仍用“字段名”，不影响返回结构
  const filters = [];
  if (startDate) filters.push(`CurrentValue.[日期 Date] >= "${startDate}"`);
  if (endDate) filters.push(`CurrentValue.[日期 Date] <= "${endDate}"`);
  if (person) {
    filters.push(
      `CurrentValue.[${TIMESHEET_PERSON_FIELD_NAME}] = "${person}"`
    );
  }
  const filterStr = filters.length ? "AND(" + filters.join(",") + ")" : "";

  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: filterStr || undefined,
  });

  const ids = await getTimesheetFieldIds();

  const mapped = records.map((r) => {
    const f = r.fields || {};

    const getById = (id) => {
      if (!id) return "";
      const v = f[id];
      if (Array.isArray(v)) return v.join(", ");
      if (v === null || v === undefined) return "";
      return v;
    };

    return {
      date: getById(ids.dateId),
      project: getById(ids.projectId),
      startTime: getById(ids.startId),
      endTime: getById(ids.endId),
      person: getById(ids.personNameId),
      hours: Number(f[ids.hoursId] || 0),
    };
  });

  return mapped;
}

// ====== 人员列表逻辑 ======

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

// 优先从“人员表”读取
async function queryAllPersonsFromPeopleTable() {
  const appToken = process.env.PEOPLE_APP_TOKEN;
  const tableId = process.env.PEOPLE_TABLE_ID;
  const nameFieldName = process.env.PEOPLE_NAME_FIELD || "姓名";

  if (!appToken || !tableId) return null; // 未配置则不使用

  const nameFieldId = await getFieldIdByName(appToken, tableId, nameFieldName);
  if (!nameFieldId) return null;

  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: undefined,
  });

  const personSet = new Set();
  for (const r of records) {
    const f = r.fields || {};
    const v = f[nameFieldId];
    const arr = extractTextValues(v);
    arr.forEach((name) => personSet.add(name));
  }

  return Array.from(personSet).sort();
}

// 退而求其次：从工时报表汇总
async function queryAllPersonsFromTimesheet() {
  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  const ids = await getTimesheetFieldIds();
  const personId = ids.personNameId;
  if (!personId) {
    console.warn("personNameId not found for timesheet table");
  }

  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: undefined,
  });

  const personSet = new Set();
  for (const r of records) {
    const f = r.fields || {};
    const v = personId ? f[personId] : null;
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
    res.status(500).json({ code: 1, msg: "debug people error: " + e.message });
  }
});

// ====== 启动服务 ======
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
