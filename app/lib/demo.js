'use strict';

/**
 * 演示数据源：未连接 AstrWeChat 时也能完整展示产品能力。
 * 消息覆盖公告、@全员、验证码、转账、快递、日程、文件、普通聊天、撤回事件等类型。
 */

const { EventEmitter } = require('events');

const SCRIPT = [
  {
    sessionId: 'product-team@chatroom',
    sessionType: 'group',
    groupName: '产品研发部',
    sourceName: '陈立',
    content: '【群公告】本周五下午 15:00 在 3 号会议室开季度评审会，请各位提前准备材料，收到请回复。',
    minutesAgo: 1
  },
  {
    sessionId: '95588',
    sessionType: 'official',
    groupName: '中国工商银行',
    sourceName: '95588',
    content: '【工商银行】您正在登录网上银行，验证码 662901，5 分钟内有效，请勿转告他人。',
    minutesAgo: 3
  },
  {
    sessionId: 'wxid_mom',
    sessionType: 'private',
    sourceName: '妈妈',
    content: '周末回来吃饭吗？给你炖了汤。',
    minutesAgo: 6
  },
  {
    sessionId: 'sf-express',
    sessionType: 'official',
    groupName: '顺丰速运',
    sourceName: '顺丰速运',
    content: '您的快递已到达阳光花园菜鸟驿站，取件码 7-3-1024，请于 24 小时内取件。',
    minutesAgo: 9
  },
  {
    sessionId: 'wxid_liqian',
    sessionType: 'private',
    sourceName: '李倩',
    content: '你收到一笔转账 ￥2,000.00，请及时查收。',
    minutesAgo: 12
  },
  {
    sessionId: 'company-notice@chatroom',
    sessionType: 'group',
    groupName: '公司通知群',
    sourceName: '行政部-周敏',
    content: '@所有人 下周一停电检修，办公区全天断电，请提前保存文件并做好远程办公安排。',
    minutesAgo: 16
  },
  {
    sessionId: 'cmb-china',
    sessionType: 'official',
    groupName: '招商银行',
    sourceName: '招商银行',
    content: '您尾号 8888 的信用卡本期账单已出，应还金额 5,320.00 元，还款日 11 月 8 日。',
    minutesAgo: 21
  },
  {
    sessionId: 'project-delivery@chatroom',
    sessionType: 'group',
    groupName: '项目交付群',
    sourceName: '刘总',
    content: '@所有人 客户要求明天上午 10 点前交付测试版本，今晚加班确认一下遗留问题。',
    minutesAgo: 25
  },
  {
    sessionId: 'wxid_liu',
    sessionType: 'private',
    sourceName: '刘总',
    content: '合同我看过了，条款没问题，明天可以签约。',
    minutesAgo: 29,
    mediaType: 'text'
  },
  {
    sessionId: 'product-team@chatroom',
    sessionType: 'group',
    groupName: '产品研发部',
    sourceName: '陈立',
    content: '[文件] 2026Q4-产品规划_v3.docx',
    mediaType: 'file',
    minutesAgo: 33
  },
  {
    sessionId: 'parents@chatroom',
    sessionType: 'group',
    groupName: '家长群',
    sourceName: '班主任王老师',
    content: '各位家长，明天上午 8:30 学校开家长会，会议重要请准时参加，不要迟到。',
    minutesAgo: 38
  },
  {
    sessionId: 'jd-service',
    sessionType: 'official',
    groupName: '京东',
    sourceName: '京东',
    content: '您的订单已签收，感谢您在京东购物，期待再次为您服务。',
    minutesAgo: 42
  },
  {
    sessionId: 'wxid_zhangwei',
    sessionType: 'private',
    sourceName: '张伟',
    content: '在吗？有个事想问你一下。',
    minutesAgo: 47
  },
  {
    sessionId: 'owner-group@chatroom',
    sessionType: 'group',
    groupName: '业主群',
    sourceName: '物业管家',
    content: '【停电通知】10 月 24 日 09:00-12:00 本小区线路检修，请提前做好准备。',
    minutesAgo: 51
  },
  {
    sessionId: 'wxid_liqian',
    sessionType: 'private',
    sourceName: '李倩',
    content: '明天的面试改到下午 3 点，记得提前 15 分钟到。',
    minutesAgo: 55
  },
  {
    sessionId: 'product-team@chatroom',
    sessionType: 'group',
    groupName: '产品研发部',
    sourceName: 'HR-赵敏',
    content: '本周五前请大家完成年度培训课程的报名，谢谢配合。',
    minutesAgo: 60
  },
  {
    sessionId: 'yoga-group@chatroom',
    sessionType: 'group',
    groupName: '瑜伽打卡群',
    sourceName: '小雅',
    content: '今天的课程改到晚上八点，记得带垫子～',
    minutesAgo: 66
  },
  {
    sessionId: 'service-notice',
    sessionType: 'system',
    groupName: '服务通知',
    sourceName: '微信团队',
    content: '你收到一条新的好友申请，点击查看。',
    minutesAgo: 72
  },
  {
    sessionId: 'product-team@chatroom',
    sessionType: 'group',
    groupName: '产品研发部',
    sourceName: '系统',
    content: '「陈立」撤回了一条消息',
    event: 'message.revoke',
    minutesAgo: 77
  },
  {
    sessionId: 'reading-club@chatroom',
    sessionType: 'group',
    groupName: '读书会',
    sourceName: '阿May',
    content: '这周的书目是《置身事内》，大家周末一起讨论～',
    minutesAgo: 83
  },
  {
    sessionId: 'wxid_mom',
    sessionType: 'private',
    sourceName: '妈妈',
    content: '天气转凉了，记得多穿点衣服。',
    minutesAgo: 90
  },
  {
    sessionId: 'news-daily',
    sessionType: 'official',
    groupName: '人民日报',
    sourceName: '人民日报',
    content: '【夜读】把日子过成自己喜欢的样子，从这三个小习惯开始。',
    minutesAgo: 96
  },
  {
    sessionId: 'wxid_wang',
    sessionType: 'private',
    sourceName: '王工',
    content: '代码我合到 main 分支了，你拉一下最新代码。',
    minutesAgo: 102
  },
  {
    sessionId: 'work-report@chatroom',
    sessionType: 'group',
    groupName: '周报群',
    sourceName: 'HR-赵敏',
    content: '@所有人 本周周报请在周五 18:00 前提交，逾期计入考核。',
    minutesAgo: 110
  }
];

function buildEvent(item, index, nowMs) {
  return {
    event: item.event || 'message.new',
    sessionId: item.sessionId,
    sessionType: item.sessionType,
    rawid: `demo-${index}-${item.sessionId}`,
    sourceName: item.sourceName || '',
    groupName: item.groupName || '',
    content: item.content,
    timestamp: Math.floor((nowMs - item.minutesAgo * 60 * 1000) / 1000),
    mediaType: item.mediaType || 'text',
    isSend: false,
    _demo: true
  };
}

class DemoSource extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.cursor = 0;
    this.started = false;
  }

  start(options = {}) {
    this.stop();
    this.started = true;
    const fast = options.fast === true;
    const nowMs = Date.now();
    const initial = fast ? 14 : 8;
    let count = 0;

    const emitNext = () => {
      if (!this.started) return;
      const index = this.cursor % SCRIPT.length;
      const item = SCRIPT[index];
      this.cursor += 1;
      this.emit('message', buildEvent(item, `${Date.now()}-${index}`, nowMs));
    };

    // 首批消息：尽快铺满界面
    const burst = () => {
      if (!this.started || count >= initial) {
        scheduleTick();
        return;
      }
      emitNext();
      count += 1;
      setTimeout(burst, fast ? 90 : 220);
    };

    const scheduleTick = () => {
      if (!this.started) return;
      this.timer = setTimeout(() => {
        emitNext();
        scheduleTick();
      }, fast ? 100000 : 9000);
    };

    burst();
  }

  stop() {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

module.exports = { DemoSource, SCRIPT };
