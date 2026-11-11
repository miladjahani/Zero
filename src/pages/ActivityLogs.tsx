import { useEffect, useState, useCallback } from 'react'
import { api } from '../lib/api'
import type { ActivityLog } from '../lib/types'
import {
  ScrollText,
  Loader2,
  KeyRound,
  Rocket,
  Bot,
  Users,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react'

const actionConfig: Record<string, { label: string; icon: typeof KeyRound; color: string; bg: string }> = {
  token_created: { label: 'توکن ساخته شد', icon: KeyRound, color: 'text-blue-400', bg: 'bg-blue-500/10' },
  token_deleted: { label: 'توکن حذف شد', icon: KeyRound, color: 'text-slate-400', bg: 'bg-slate-700/30' },
  deployment_created: { label: 'استقرار شروع شد', icon: Rocket, color: 'text-warning-400', bg: 'bg-warning-500/10' },
  deployment_deployed: { label: 'ورکر مستقر شد', icon: CheckCircle2, color: 'text-green-400', bg: 'bg-green-500/10' },
  deployment_failed: { label: 'استقرار ناموفق', icon: AlertCircle, color: 'text-error-400', bg: 'bg-error-500/10' },
  bot_configured: { label: 'ربات پیکربندی شد', icon: Bot, color: 'text-brand-400', bg: 'bg-brand-500/10' },
  bot_user_joined: { label: 'کاربر جدید ربات', icon: Users, color: 'text-purple-400', bg: 'bg-purple-500/10' },
}

export default function ActivityLogs() {
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<string>('all')

  const load = useCallback(async () => {
    try {
      const { data } = await api<{ data: ActivityLog[] }>('/logs')
      setLogs(data ?? [])
    } catch {
      setLogs([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = filter === 'all' ? logs : logs.filter(l => l.entity_type === filter)

  const entityTypes = ['all', 'token', 'deployment', 'bot']

  if (loading) {
    return <div className="flex items-center justify-center h-96"><Loader2 className="w-8 h-8 animate-spin text-brand-400" /></div>
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">لاگ‌های فعالیت</h1>
        <p className="text-slate-400 text-sm mt-1">تاریخچه تمام فعالیت‌های انجام شده در پنل</p>
      </div>

      {/* Filter */}
      <div className="flex gap-2 flex-wrap">
        {entityTypes.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              filter === f ? 'bg-brand-600 text-white' : 'bg-slate-800/50 text-slate-400 hover:text-white'
            }`}
          >
            {f === 'all' ? 'همه' : f === 'token' ? 'توکن‌ها' : f === 'deployment' ? 'استقرارها' : 'ربات'}
          </button>
        ))}
      </div>

      {/* Timeline */}
      {filtered.length === 0 ? (
        <div className="glass-card p-12 text-center">
          <ScrollText className="w-12 h-12 text-slate-600 mx-auto mb-4" />
          <p className="text-slate-400">هنوز فعالیتی ثبت نشده</p>
        </div>
      ) : (
        <div className="glass-card p-6">
          <div className="space-y-1">
            {filtered.map((log, i) => {
              const cfg = actionConfig[log.action] ?? { label: log.action, icon: ScrollText, color: 'text-slate-400', bg: 'bg-slate-700/30' }
              const Icon = cfg.icon
              return (
                <div key={log.id} className="flex items-start gap-4 p-3 rounded-xl hover:bg-slate-800/30 transition-colors animate-fade-in" style={{ animationDelay: `${i * 30}ms` }}>
                  <div className={`p-2.5 rounded-xl ${cfg.bg} shrink-0`}>
                    <Icon className={`w-4 h-4 ${cfg.color}`} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <p className="text-sm text-white font-medium">{cfg.label}</p>
                      <span className="text-xs text-slate-500">{new Date(log.created_at).toLocaleString('fa-IR')}</span>
                    </div>
                    {log.entity_name && <p className="text-xs text-slate-400 mt-0.5 truncate" dir="ltr">{log.entity_name}</p>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
