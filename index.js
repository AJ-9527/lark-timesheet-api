// index.js
// 简单的 Express + Lark Bitable 查询服务

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

// ========== Bitable 查询逻辑 ==========

/**
 * 从 Bitable 读取工时报表
 * @param {Object} options
 * @param {string} [options.startDate] - 例如 "2025-03-01"
 * @param {string} [options.endDate]   - 例如 "2025-03-31"
 * @param {string} [options.person]    - 人员的名字（必须跟 Bitable 里字段值一致）
 */
async function queryTimesheetRecords({ startDate, endDate, person }) {
  const token = await getTenantAccessToken();

  // 构造 filter 公式（注意字段名要跟 Bitable 一致）
  const filters = [];

  if (startDate) {
    filters.push(`CurrentValue.[日期 Date] >= "${startDate}"`);
  }
  if (endDate) {
    filters.push(`CurrentValue.[日期 Date] <= "${endDate}"`);
  }
  if (person) {
    filters.push(`CurrentValue.[人员 Applicant] = "${person}"`);
  }

  let filterStr = '';
  if (filters.length > 0) {
    filterStr = 'AND(' + filters.join(',') + ')';
  }

  const appToken = process.env.BITABLE_APP_TOKEN;
  const tableId = process.env.BITABLE_TABLE_ID;

  let pageToken = undefined;
  const allRecords = [];

  do {
    const params = {
      page_size: 500,
    };
    if (filterStr) params.filter = filterStr;
    if (pageToken) params.page_token = pageToken;

    const resp = await axios.get(
      `https://open.larksuite.com/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params,
      }
    );

    if (resp.data.code !== 0) {
      console.error('queryTimesheetRecords error:', resp.data);
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

  // 映射成前端需要的结构
  const mapped = allRecords.map((r) => {
    const f = r.fields || {};

    // 如果某些字段是数组（多选），简单转成字符串
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
      person: normalize(f['人员 Applicant']),
      hours: Number(f['工时'] || 0),
    };
  });

  return mapped;
}

// ========== 简单健康检查 ==========
app.get('/ping', (req, res) => {
  res.send('OK');
});

// ========== 查询接口 ==========
// 例：/api/timesheet?start_date=2025-03-01&end_date=2025-03-31&person=张三
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

// ========== 启动服务 ==========
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
