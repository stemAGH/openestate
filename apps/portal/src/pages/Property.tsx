import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { formatDate, formatArea, toAreaScaled, convertFromSqftScaled, type AreaUnit } from '@openestate/shared';
import { api, downloadFile, fetchAsObjectUrl } from '../lib/api';

interface ConstructionMedia {
  id: string;
  originalName: string;
  mimeType: string;
}

interface ConstructionUpdate {
  id: string;
  title: string;
  description: string | null;
  publishedAt: string;
  media: ConstructionMedia[];
}

interface ProjectMediaItem {
  id: string;
  category: string;
  originalName: string;
  mimeType: string;
}

interface PropertyEntry {
  bookingId: string;
  bookingNumber: string;
  status: string;
  allotmentDate: string | null;
  registrationDate: string | null;
  unit: {
    number: string;
    typeName: string | null;
    carpetAreaSqft: string | null;
    // LAND_BASED only — the client's own entered (value, unit) pair,
    // plus the derived canonical sqft used to display in the project's
    // default unit (falls back to the entered pair if the project has
    // none set).
    landAreaEntered: string | null;
    landAreaEnteredUnit: AreaUnit | null;
    landAreaSqft: string | null;
  };
  // null for a LAND_BASED booking (Phase A) — no tower/floor exists.
  tower: { name: string } | null;
  floor: { name: string } | null;
  // LAND_BASED only, and only when the plot is grouped.
  inventoryGroup: { name: string } | null;
  project: {
    id: string;
    name: string;
    address: string | null;
    expectedEndDate: string | null;
    landAreaDefaultUnit: AreaUnit | null;
  };
  constructionUpdates: ConstructionUpdate[];
  projectMedia: ProjectMediaItem[];
}

const MEDIA_CATEGORY_LABELS: Record<string, string> = {
  layout_plan: 'Layout Plan',
  brochure: 'Brochure',
  photo: 'Photo',
};

/** Fetches an authenticated image as a blob object URL and renders it —
 * a plain <img src> can't carry the in-memory Bearer token. */
function AuthedImage({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchAsObjectUrl(path)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  if (!src) return <div className="h-24 w-24 shrink-0 animate-pulse rounded bg-slate-100" />;
  return <img src={src} alt={alt} className="h-24 w-24 shrink-0 rounded object-cover" />;
}

export default function Property() {
  const { data, isLoading } = useQuery<PropertyEntry[]>({
    queryKey: ['portal', 'property'],
    queryFn: () => api('/portal/property'),
  });

  if (isLoading) return <div className="text-slate-500 text-sm">Loading…</div>;
  if (!data || data.length === 0) {
    return <div className="text-slate-500 text-sm">No property found on your account yet.</div>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold text-slate-900">My Property</h1>

      {data.map((p) => {
        const documents = p.projectMedia.filter((m) => !m.mimeType.startsWith('image/'));
        const photos = p.projectMedia.filter((m) => m.mimeType.startsWith('image/'));
        return (
          <div key={p.bookingId} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium text-slate-900 truncate min-w-0">{p.project.name}</span>
              <span className="text-xs rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 shrink-0">{p.status}</span>
            </div>
            <p className="text-sm text-slate-600 mt-1">
              {p.tower && p.floor
                ? `${p.tower.name} · ${p.floor.name} · Unit ${p.unit.number}`
                : p.inventoryGroup
                  ? `${p.inventoryGroup.name} · Plot ${p.unit.number}`
                  : `Plot ${p.unit.number}`}
              {p.unit.typeName ? ` (${p.unit.typeName})` : ''}
            </p>
            {p.unit.carpetAreaSqft && (
              <p className="text-xs text-slate-500 mt-0.5">{p.unit.carpetAreaSqft} sqft carpet area</p>
            )}
            {p.unit.landAreaEntered && p.unit.landAreaEnteredUnit && (
              <p className="text-xs text-slate-500 mt-0.5">
                {p.project.landAreaDefaultUnit && p.unit.landAreaSqft
                  ? formatArea(
                      convertFromSqftScaled(toAreaScaled(p.unit.landAreaSqft), p.project.landAreaDefaultUnit),
                      p.project.landAreaDefaultUnit,
                    )
                  : formatArea(toAreaScaled(p.unit.landAreaEntered), p.unit.landAreaEnteredUnit)}
              </p>
            )}
            {p.project.address && <p className="text-xs text-slate-500 mt-0.5">{p.project.address}</p>}
            {p.project.expectedEndDate && (
              <p className="text-xs text-slate-500 mt-0.5">
                Tentative possession: {formatDate(p.project.expectedEndDate)}
              </p>
            )}

            {documents.length > 0 && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <h3 className="text-sm font-medium text-slate-700">Layout plans &amp; brochures</h3>
                <ul className="mt-2 space-y-1">
                  {documents.map((m) => (
                    <li key={m.id}>
                      <button
                        onClick={() => downloadFile(`/portal/property/media/${m.id}/download`, m.originalName)}
                        className="text-sm text-blue-600 hover:text-blue-800 text-left"
                      >
                        {MEDIA_CATEGORY_LABELS[m.category] ?? m.category}: {m.originalName}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {photos.length > 0 && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <h3 className="text-sm font-medium text-slate-700">Photos</h3>
                <div className="mt-2 flex flex-wrap gap-2">
                  {photos.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => downloadFile(`/portal/property/media/${m.id}/download`, m.originalName)}
                      title={m.originalName}
                    >
                      <AuthedImage path={`/portal/property/media/${m.id}/download`} alt={m.originalName} />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {p.constructionUpdates.length > 0 && (
              <div className="mt-3 border-t border-slate-100 pt-3">
                <h3 className="text-sm font-medium text-slate-700">Construction progress</h3>
                <div className="mt-2 space-y-3">
                  {p.constructionUpdates.map((u) => (
                    <div key={u.id}>
                      <div className="flex items-baseline justify-between">
                        <span className="text-sm text-slate-800">{u.title}</span>
                        <span className="text-xs text-slate-400">
                          {formatDate(u.publishedAt)}
                        </span>
                      </div>
                      {u.description && <p className="text-xs text-slate-500">{u.description}</p>}
                      {u.media.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {u.media.map((med) => (
                            <button
                              key={med.id}
                              onClick={() => downloadFile(`/portal/property/construction-media/${med.id}/download`, med.originalName)}
                              title={med.originalName}
                            >
                              <AuthedImage path={`/portal/property/construction-media/${med.id}/download`} alt={med.originalName} />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
