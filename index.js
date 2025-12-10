// index.js
// Lark Bitable 工时查询服务：
// - /api/timesheet  按日期/人员查询打卡记录（用“人员姓名 NameText”做筛选）
// - /api/people     从打卡记录表中汇总所有出现过的“人员姓名 NameText”

const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 静态文件服务：用于前端页面（public/index.html）
app.use(express.static('public'));

// ========== Lark tenant_access_token 缓存 ==========
let cachedToken = null;
let tokenExpireAt = 0; // 时间戳（毫秒）

async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpireAt) {
    return cachedToken;
  }

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
  tokenExpireAt = now + (expireSeconds - 60) * 1000; // 提前 60 秒过期
  return cachedToken;
}

// 通用：调用 Bitable List Records
async function listBitableRecords({ appToken, tableId, filter }) {
  const token = await getTenantAccessToken();
  let pageToken = undefined;
  const allRecords = [];

  do {
    const params = {
      page_size: 500,
      // 关键：让返回值里的 key 使用“字段名”而不是 field_id
      field_names: true,
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

    if (data.has_more) {
      pageToken = data.page_token;
    } else {
      pageToken = undefined;
    }
  } while (pageToken);

  return allRecords;
}

// ========== 查询工时记录 ==========
//
// @param startDate: "YYYY-MM-DD"
// @param endDate:   "YYYY-MM-DD"
// @param person:    与“人员姓名 NameText”字段里的显示值一致
//
async function queryTimesheetRecords({ startDate, endDate, person }) {
  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  // 构造 filter 公式（注意字段名要跟 Bitable 完全一致）
  const filters = [];
  if (startDate) {
    filters.push(`CurrentValue.[日期 Date] >= "${startDate}"`);
  }
  if (endDate) {
    filters.push(`CurrentValue.[日期 Date] <= "${endDate}"`);
  }
  if (person) {
    // 这里改成用“人员姓名 NameText”做筛选
    filters.push(`CurrentValue.[人员姓名 NameText] = "${person}"`);
  }

  let filterStr = '';
  if (filters.length > 0) {
    filterStr = 'AND(' + filters.join(',') + ')';
  }

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

    return {
      date: normalize(f['日期 Date']),
      project: normalize(f['项目 Project']),
      startTime: normalize(f['开工时间 Start Time']),
      endTime: normalize(f['结束时间 End Time']),
      // 关键：这里也改成用“人员姓名 NameText”
      person: normalize(f['人员姓名 NameText']),
      hours: Number(f['工时'] || 0),
    };
  });

  return mapped;
}

// ========== 从打卡记录表中读取所有出现过的人员姓名 ==========
async function queryAllPersons() {
  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  const records = await listBitableRecords({
    appToken,
    tableId,
    filter: undefined, // 不加筛选，整张表都看一遍
  });

  const personSet = new Set();

  for (const r of records) {
    const f = r.fields || {};
    let v = f['人员姓名 NameText']; // 直接读纯文本姓名

    if (Array.isArray(v)) {
      v.forEach((item) => {
        if (typeof item === 'string') {
          personSet.add(item);
        }
      });
    } else if (typeof v === 'string') {
      personSet.add(v);
    }
  }

  return Array.from(personSet).sort();
}

// ========== 健康检查 ==========
app.get('/ping', (req, res) => {
  res.send('OK');
});

// ========== API：工时查询 ==========
app.get('/api/timesheet', async (req, res) => {
  try {
    const { start_date, end_date, person } = req.query;

    const records = await queryTimesheetRecords({
      startDate: start_date,
      endDate: end_date,
      person,
    });

    res.json({
      code: 0,
      data: records,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      code: 1,
      msg: 'Server error',
    });
  }
});

// ========== API：人员列表 ==========
app.get('/api/people', async (req, res) => {
  try {
    const persons = await queryAllPersons();
    res.json({
      code: 0,
      data: persons,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      code: 1,
      msg: 'Server error',
    });
  }
});

// ========== 启动服务 ==========
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
