import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { listPresets, listProjects } from '../lib/api';
import { Uploader } from '../components/Uploader';

const STATUS_TONE: Record<string, string> = {
  done: 'text-emerald-400',
  failed: 'text-red-400',
  ready_to_render: 'text-sky-400',
};

export function DashboardPage() {
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    refetchInterval: 5000,
  });
  const presets = useQuery({ queryKey: ['presets'], queryFn: listPresets });

  return (
    <div className="space-y-8">
      <Uploader presets={presets.data?.presets ?? []} />

      <div>
        <h2 className="mb-3 text-lg font-semibold">Your reels</h2>
        {projects.isLoading && <p className="text-sm text-neutral-500">Loading…</p>}
        {projects.data?.length === 0 && (
          <p className="text-sm text-neutral-500">Nothing here yet. Upload your first reel above.</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {projects.data?.map((p) => (
            <Link
              key={p.id}
              to={`/project/${p.id}`}
              className="rounded-xl border border-neutral-800 bg-neutral-900 p-4 transition-colors hover:border-neutral-600"
            >
              <div className="truncate font-medium">{p.title ?? 'Untitled'}</div>
              <div className={`text-xs ${STATUS_TONE[p.status] ?? 'text-neutral-400'}`}>
                {p.status.replace(/_/g, ' ')}
                {p.duration_seconds ? ` · ${p.duration_seconds.toFixed(0)}s` : ''}
              </div>
              <div className="mt-1 text-[11px] text-neutral-600">
                {new Date(p.created_at).toLocaleString()}
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
