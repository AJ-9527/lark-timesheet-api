// index.js
// Lark Bitable 工时查询服务
// - /api/timesheet  按日期/人员查询打卡记录
// - /api/people     获取人员列表（优先用人员名单表，无则从打卡表汇总）

const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== 静态页面 =====
app.use(express.static('public'));

// ===== Lark tenant_access_token 缓存 =====
let cachedToken = null;
let tokenExpireAt = 0; // ms

async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpireAt) return cachedToken;

  const resp = await axios.post(
    'https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal',
    {
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  if (resp.data.code !== 0) {
    console.error('getTenantAccessToken error:', resp.data);
    throw new Error('Failed to get tenant_access_token: ' + resp.data.msg);
  }

  cachedToken = resp.data.tenant_access_token;
  const expireSeconds = resp.data.expire || 3600;
  tokenExpireAt = now + (expireSeconds - 60) * 1000;
  return cachedToken;
}

// ===== 通用：读取 Bitable 记录 =====
async function listBitableRecords({ appToken, tableId, filter }) {
  const token = await getTenantAccessToken();
  let pageToken = undefined;
  const allRecords = [];

  do {
    const params = {
      page_size: 500,
      field_names: true, // 用字段名作为 key
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
      console.error('listBitableRecords error:', resp.data);
      throw new Error('Failed to list records: ' + resp.data.msg);
    }

    const data = resp.data.data || {};
    const items = data.items || [];
    allRecords.push(...items);

    pageToken = data.has_more ? data.page_token : undefined;
  } while (pageToken);

  return allRecords;
}

// ===== 工时查询逻辑 =====

// 允许通过环境变量指定“工时报表里用于显示/筛选人的字段名”
// 默认用：人员姓名 NameText
const TIMESHEET_PERSON_FIELD_NAME =
  process.env.TIMESHEET_PERSON_FIELD_NAME || '人员姓名 NameText';

async function queryTimesheetRecords({ startDate, endDate, person }) {
  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  const filters = [];
  if (startDate) {
    filters.push(`CurrentValue.[日期 Date] >= "${startDate}"`);
  }
  if (endDate) {
    filters.push(`CurrentValue.[日期 Date] <= "${endDate}"`);
  }
  if (person) {
    // 用“人员姓名 NameText”做筛选（或你在 env 里指定的字段）
    filters.push(`CurrentValue.[${TIMESHEET_PERSON_FIELD_NAME}] = "${person}"`);
  }

  const filterStr = filters.length ? 'AND(' + filters.join(',') + ')' : '';

  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: filterStr || undefined,
  });

  const mapped = records.map((r) => {
    const f = r.fields || {};

    const normalize = (v) => {
      if (Array.isArray(v)) return v.join(', ');
      if (v === null || v === undefined) return '';
      return v;
    };

    // 如果你忘了建“人员姓名 NameText”，尝试从其它字段兜底一下
    const personValue =
      f[TIMESHEET_PERSON_FIELD_NAME] ||
      f['人员姓名 NameText'] ||
      f['人员 Applicant'];

    return {
      date: normalize(f['日期 Date']),
      project: normalize(f['项目 Project']),
      startTime: normalize(f['开工时间 Start Time']),
      endTime: normalize(f['结束时间 End Time']),
      person: normalize(personValue),
      hours: Number(f['工时'] || 0),
    };
  });

  return mapped;
}

// ===== 人员列表逻辑 =====
//
// 优先来源 1：单独的“人员名单表”
//   通过三个 env 指定：
//   - PEOPLE_APP_TOKEN
//   - PEOPLE_TABLE_ID
//   - PEOPLE_NAME_FIELD （默认 "姓名"）
//
// 如果没有配置上述 env，则来源 2：工时报表里的“人员姓名 NameText”字段
//

async function queryAllPersonsFromPeopleTable() {
  const appToken = process.env.PEOPLE_APP_TOKEN;
  const tableId = process.env.PEOPLE_TABLE_ID;
  const nameField = process.env.PEOPLE_NAME_FIELD || '姓名';

  if (!appToken || !tableId) return null; // 没配就返回 null，让上层走 fallback

  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: undefined,
  });

  const personSet = new Set();

  for (const r of records) {
    const f = r.fields || {};
    const v = f[nameField];
    if (typeof v === 'string' && v.trim()) {
      personSet.add(v.trim());
    }
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
      f['人员姓名 NameText'] ||
      f['人员 Applicant'];

    if (Array.isArray(v)) {
      v.forEach((item) => {
        if (typeof item === 'string' && item.trim()) {
          personSet.add(item.trim());
        } else if (item && typeof item === 'object') {
          if (item.text && String(item.text).trim()) {
            personSet.add(String(item.text).trim());
          }
          if (item.name && String(item.name).trim()) {
            personSet.add(String(item.name).trim());
          }
        }
      });
    } else if (typeof v === 'string' && v.trim()) {
      personSet.add(v.trim());
    }
  }

  return Array.from(personSet).sort();
}

async function queryAllPersons() {
  // 优先尝试“人员名单表”
  try {
    const fromPeopleTable = await queryAllPersonsFromPeopleTable();
    if (fromPeopleTable && fromPeopleTable.length) return fromPeopleTable;
  } catch (e) {
    console.warn('queryAllPersonsFromPeopleTable failed, fallback to timesheet:', e.message);
  }

  // 否则用工时报表汇总
  return await queryAllPersonsFromTimesheet();
}

// ===== 健康检查 =====
app.get('/ping', (req, res) => {
  res.send('OK');
});

// ===== API：工时查询 =====
app.get('/api/timesheet', async (req, res) => {
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
    res.status(500).json({ code: 1, msg: 'Server error' });
  }
});

// ===== API：人员列表 =====
app.get('/api/people', async (req, res) => {
  try {
    const persons = await queryAllPersons();
    res.json({ code: 0, data: persons });
  } catch (err) {
    console.error(err);
    res.status(500).json({ code: 1, msg: 'Server error' });
  }
});

// ===== 调试接口：返回一条打卡记录的原始字段，用于确认字段名 =====
app.get('/api/debug-record', async (req, res) => {
  try {
    const appToken = process.env.BITABLE_APP_TOKEN;
    const tableId = process.env.BITABLE_TABLE_ID;

    // 只取 1 条
    const records = await listBitableRecords({
      appToken,
      tableId,
      filter: undefined,
    });

    if (!records.length) {
      return res.json({ code: 0, msg: 'no records', fields: {} });
    }

    const first = records[0];
    return res.json({
      code: 0,
      msg: 'ok',
      fields: first.fields || {},
    });
  } catch (e) {
    console.error('debug-record error', e);
    res.status(500).json({ code: 1, msg: 'debug error: ' + e.message });
  }
});

// ===== 启动服务 =====
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
