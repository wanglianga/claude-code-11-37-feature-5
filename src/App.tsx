import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  BarChart3,
  Database,
  FlaskConical,
  Gauge,
  PlayCircle,
  Share2,
  ShieldCheck,
} from 'lucide-react';
import { ACCOUNTS } from '@/lib/constants';
import { useAppStore } from '@/store/useAppStore';
import DataIngestionPage from '@/pages/DataIngestionPage';
import RunsPage from '@/pages/RunsPage';
import ReportPage from '@/pages/ReportPage';
import BudgetPage from '@/pages/BudgetPage';
import SharePage from '@/pages/SharePage';
import EvaluationPage from '@/pages/EvaluationPage';
import ReviewPage from '@/pages/ReviewPage';

const NAV = [
  { to: '/', label: '数据接入与血缘', sub: '输入快照 · 授权边界', icon: Database },
  { to: '/runs', label: '归因运行', sub: '草稿 · 审批 · 锁定', icon: PlayCircle },
  { to: '/report', label: '渠道贡献报告', sub: '订单回查 · 模型对比', icon: BarChart3 },
  { to: '/evaluation', label: '模型评估', sub: '样本 · 稳定性 · 分群', icon: Gauge },
  { to: '/review', label: '审查与发布', sub: '模型修订 · 样本冻结', icon: ShieldCheck },
  { to: '/budget', label: '预算方案', sub: '只读已完成运行', icon: FlaskConical },
  { to: '/share', label: '共享报告', sub: '冻结快照 · 不可变', icon: Share2 },
];

const TITLES: Record<string, [string, string]> = {
  '/': ['数据接入与血缘', '数据接入、触点归并与订单净额计算形成可追溯输入'],
  '/runs': ['归因运行', '绑定时区、成交定义、窗口与规则修订；并行模型只在同一快照上计算'],
  '/report': ['渠道贡献报告', '份额总和不超过净收入；平台汇总与订单明细分离展示'],
  '/evaluation': ['归因模型评估与适用范围', '成熟共同样本做版本比较，近期窗口另做漂移监测；没有真实贡献标签，不输出准确率'],
  '/review': ['评估审查与发布', '审查引用确定的模型修订与样本哈希；撤回后不可作为新分析的有效性证明'],
  '/budget': ['预算方案', '只读取已完成的归因运行，模拟不回写实际订单'],
  '/share': ['共享报告', '报告固定引用已锁定运行，迟到退款生成新运行不改旧分享'],
};

export default function App() {
  const currentUserId = useAppStore((s) => s.currentUserId);
  const switchUser = useAppStore((s) => s.switchUser);
  const resetDemo = useAppStore((s) => s.resetDemo);
  const location = useLocation();
  const [title, sub] = TITLES[location.pathname] ?? TITLES['/'];
  const account = ACCOUNTS.find((a) => a.userId === currentUserId);

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="brand">
          <BarChart3 size={20} />
          <div>
            渠道归因工作台
            <small>Channel Attribution Workbench</small>
          </div>
        </div>
        {NAV.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <Icon size={17} />
              <div>
                {item.label}
                <div className="desc">{item.sub}</div>
              </div>
            </NavLink>
          );
        })}
        <div className="sidebar-foot">
          <button className="sm" style={{ width: '100%', background: 'transparent', color: '#94a3b8', borderColor: '#26334d' }} onClick={() => { if (confirm('清空所有运行、共享与预算方案，恢复演示初始状态？')) resetDemo(); }}>
            重置演示数据
          </button>
          <p style={{ marginTop: 10, lineHeight: 1.6 }}>
            所有归因结果仅为规则分摊，<br />不代表渠道因果关系。
          </p>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div>
            <div className="page-title">{title}</div>
            <div className="page-sub">{sub}</div>
          </div>
          <div className="user-switch">
            <span className="muted">当前身份（模拟登录）：</span>
            <select
              value={currentUserId}
              onChange={(e) => switchUser(e.target.value)}
              style={{ minWidth: 260 }}
              title={account?.description}
            >
              {ACCOUNTS.map((a) => (
                <option key={a.userId} value={a.userId}>
                  {a.name}（{a.role === 'owner' ? '投放负责人' : '分析师'}）
                </option>
              ))}
            </select>
          </div>
        </header>
        <main className="content">
          <Routes>
            <Route path="/" element={<DataIngestionPage />} />
            <Route path="/runs" element={<RunsPage />} />
            <Route path="/report" element={<ReportPage />} />
            <Route path="/evaluation" element={<EvaluationPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/budget" element={<BudgetPage />} />
            <Route path="/share" element={<SharePage />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}
