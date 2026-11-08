import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AREA_UNITS, displayLabel, formatArea, toAreaScaled, type AreaUnit } from '@openestate/shared';
import { api, downloadFile } from '../../lib/api';
import { useApiMutation } from '../../lib/hooks';
import CustomFieldInputs, {
  CustomFieldDisplay,
  buildCustomFieldPayload,
  useCustomFieldDefinitions,
} from '../../components/CustomFieldInputs';

interface Project {
  id: string;
  name: string;
  code: string;
  reraNumber: string | null;
  projectTypeId: string | null;
  areaLocationId: string | null;
  address: string | null;
  description: string | null;
  startDate: string | null;
  expectedEndDate: string | null;
  shape: 'HIGH_RISE' | 'LAND_BASED';
  landAreaDefaultUnit: AreaUnit | null;
  customFields?: Record<string, unknown> | null;
}

interface Tower {
  id: string;
  name: string;
  code: string;
  /**
   * Planned floor count, captured once on the Add Tower form and never
   * updated afterwards — bulk-generating units creates real Floor rows
   * without touching it. Kept because it IS the admin's stated intent
   * at creation, but never rendered as if it were the actual count.
   */
  totalFloors: number;
  /** Real floor count, computed by the API (`_count: { floors: true }`). */
  _count?: { floors: number };
}

interface Unit {
  id: string;
  number: string;
  status: string;
  baseRatePaise: string;
  carpetAreaSqft: string | null;
  // LAND_BASED only — null on HIGH_RISE.
  landAreaEntered: string | null;
  landAreaEnteredUnit: AreaUnit | null;
  facing: string | null;
  landRecordRef: string | null;
  inventoryGroup: { id: string; name: string } | null;
}

interface InventoryGroup {
  id: string;
  name: string;
  code: string;
  kind: string | null;
  isActive: boolean;
  _count?: { units: number };
}

interface RateRevision {
  id: string;
  ratePaise: string;
  effectiveFrom: string;
  reason: string | null;
}

interface MasterOption {
  id: string;
  name: string;
}

interface UnitPlc {
  id: string;
  amountPaise: string;
  percentage: string | null;
  plcType: MasterOption;
}

interface UnitCharge {
  id: string;
  amountPaise: string;
  chargeType: MasterOption;
}

interface ProjectMediaItem {
  id: string;
  category: string;
  originalName: string;
}

interface ConstructionUpdateMediaItem {
  id: string;
  originalName: string;
}

interface ConstructionUpdateItem {
  id: string;
  title: string;
  description: string | null;
  publishedAt: string;
  media: ConstructionUpdateMediaItem[];
}

const rupees = (paise: string | number) => `₹${(Number(paise) / 100).toLocaleString('en-IN')}`;

const MEDIA_CATEGORY_LABELS: Record<string, string> = {
  layout_plan: 'Layout Plan',
  brochure: 'Brochure',
  photo: 'Photo',
};

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const [showTowerForm, setShowTowerForm] = useState(false);
  const [towerName, setTowerName] = useState('');
  const [towerCode, setTowerCode] = useState('');
  const [towerFloors, setTowerFloors] = useState('1');
  const [towerError, setTowerError] = useState('');

  const [showBulkForm, setShowBulkForm] = useState(false);
  const [bulkTowerId, setBulkTowerId] = useState('');
  const [floorStart, setFloorStart] = useState('1');
  const [floorEnd, setFloorEnd] = useState('1');
  const [unitsPerFloor, setUnitsPerFloor] = useState('4');
  const [unitPrefix, setUnitPrefix] = useState('');
  const [unitTypeId, setUnitTypeId] = useState('');
  const [carpetAreaSqft, setCarpetAreaSqft] = useState('');
  const [baseRateRupees, setBaseRateRupees] = useState('');
  const [bulkError, setBulkError] = useState('');

  const [selectedTowerFilter, setSelectedTowerFilter] = useState('');
  const [selectedUnitIds, setSelectedUnitIds] = useState<Set<string>>(new Set());

  // ── LAND_BASED: inventory groups ──────────────────────────
  const [showGroupForm, setShowGroupForm] = useState(false);
  const [groupName, setGroupName] = useState('');
  const [groupCode, setGroupCode] = useState('');
  const [groupKind, setGroupKind] = useState('');
  const [groupError, setGroupError] = useState('');
  const [selectedGroupFilter, setSelectedGroupFilter] = useState('');

  // ── LAND_BASED: plot (unit) create form ───────────────────
  const [showLandUnitForm, setShowLandUnitForm] = useState(false);
  const [landUnitNumber, setLandUnitNumber] = useState('');
  const [landUnitGroupId, setLandUnitGroupId] = useState('');
  const [landUnitTypeId, setLandUnitTypeId] = useState('');
  const [landAreaEntered, setLandAreaEntered] = useState('');
  const [landAreaEnteredUnit, setLandAreaEnteredUnit] = useState<AreaUnit>('ACRE');
  const [landRateUnit, setLandRateUnit] = useState<AreaUnit>('ACRE');
  const [landBaseRateRupees, setLandBaseRateRupees] = useState('');
  const [landBuiltUpAreaSqft, setLandBuiltUpAreaSqft] = useState('');
  const [landBuiltUpRateRupees, setLandBuiltUpRateRupees] = useState('');
  const [landRecordRef, setLandRecordRef] = useState('');
  const [landFacing, setLandFacing] = useState('');
  const [landLengthFeet, setLandLengthFeet] = useState('');
  const [landBreadthFeet, setLandBreadthFeet] = useState('');
  const [landUnitError, setLandUnitError] = useState('');

  // ── XLSX import ────────────────────────────────────────────
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importError, setImportError] = useState('');
  const [importResult, setImportResult] = useState<{
    createdCount: number;
    skippedCount: number;
    errorCount: number;
    errors: Array<{ row: number; field: string; message: string }>;
    skipped: Array<{ row: number; unitNumber: string; reason: string }>;
  } | null>(null);
  const [revisionRateRupees, setRevisionRateRupees] = useState('');
  const [revisionEffectiveFrom, setRevisionEffectiveFrom] = useState('');
  const [revisionReason, setRevisionReason] = useState('');
  const [revisionError, setRevisionError] = useState('');

  const [historyUnitId, setHistoryUnitId] = useState<string | null>(null);

  const [pricingUnitId, setPricingUnitId] = useState<string | null>(null);
  const [newPlcTypeId, setNewPlcTypeId] = useState('');
  const [newPlcPercentage, setNewPlcPercentage] = useState('');
  const [newChargeTypeId, setNewChargeTypeId] = useState('');
  const [newChargeAmountRupees, setNewChargeAmountRupees] = useState('');
  const [pricingError, setPricingError] = useState('');

  const [mediaCategory, setMediaCategory] = useState<'layout_plan' | 'brochure' | 'photo'>('layout_plan');
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [mediaError, setMediaError] = useState('');

  const [raisingStage, setRaisingStage] = useState<{ templateId: string; milestoneSeq: number; label: string } | null>(null);
  const [stageCompletedOn, setStageCompletedOn] = useState(() => new Date().toISOString().slice(0, 10));
  const [stageRaiseError, setStageRaiseError] = useState('');
  const [stageRaiseResult, setStageRaiseResult] = useState('');

  const [newUpdateTitle, setNewUpdateTitle] = useState('');
  const [newUpdateDescription, setNewUpdateDescription] = useState('');
  const [newUpdatePublishedAt, setNewUpdatePublishedAt] = useState('');
  const [updateError, setUpdateError] = useState('');
  const [updatePhotoFiles, setUpdatePhotoFiles] = useState<Record<string, File | null>>({});

  const [showEditForm, setShowEditForm] = useState(false);
  const [editName, setEditName] = useState('');
  const [editReraNumber, setEditReraNumber] = useState('');
  const [editProjectTypeId, setEditProjectTypeId] = useState('');
  const [editAreaLocationId, setEditAreaLocationId] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editStartDate, setEditStartDate] = useState('');
  const [editExpectedEndDate, setEditExpectedEndDate] = useState('');
  const [editCustomFieldValues, setEditCustomFieldValues] = useState<Record<string, unknown>>({});
  const [editError, setEditError] = useState('');
  const [showAreaChangeConfirm, setShowAreaChangeConfirm] = useState(false);

  const { data: project } = useQuery<Project>({
    queryKey: ['project', id],
    queryFn: () => api(`/projects/${id}`),
    enabled: !!id,
  });
  const { definitions: projectDefs } = useCustomFieldDefinitions('PROJECT');

  const { data: towersRes } = useQuery<{ data: Tower[] }>({
    queryKey: ['towers', id],
    queryFn: () => api(`/projects/${id}/towers?page=1&limit=100`),
    enabled: !!id,
  });
  const towers = towersRes?.data;

  const { data: groupsRes } = useQuery<{ data: InventoryGroup[] }>({
    queryKey: ['inventory-groups', id],
    queryFn: () => api(`/projects/${id}/inventory-groups?page=1&limit=100`),
    enabled: !!id && project?.shape === 'LAND_BASED',
  });
  const groups = groupsRes?.data;

  const { data: unitTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'unit-types', 'all'],
    queryFn: () => api('/masters/unit-types?limit=100'),
  });

  const [unitStatusFilter, setUnitStatusFilter] = useState('');

  const { data: units, isLoading: unitsLoading } = useQuery<{ data: Unit[] }>({
    queryKey: ['units', id, selectedTowerFilter, selectedGroupFilter, unitStatusFilter],
    queryFn: () => {
      const params = new URLSearchParams({ page: '1', limit: '100' });
      if (selectedTowerFilter) params.set('towerId', selectedTowerFilter);
      if (selectedGroupFilter) params.set('inventoryGroupId', selectedGroupFilter);
      if (unitStatusFilter) params.set('status', unitStatusFilter);
      return api(`/projects/${id}/units?${params.toString()}`);
    },
    enabled: !!id,
  });

  const { data: rateHistory } = useQuery<{ data: RateRevision[] }>({
    queryKey: ['rate-history', id, historyUnitId],
    queryFn: () => api(`/projects/${id}/units/${historyUnitId}/rate-history?page=1&limit=50`),
    enabled: !!id && !!historyUnitId,
  });

  const { data: plcTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'plc-types', 'all'],
    queryFn: () => api('/masters/plc-types?limit=100'),
  });
  const { data: chargeTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'charge-types', 'all'],
    queryFn: () => api('/masters/charge-types?limit=100'),
  });
  const { data: unitPlcs } = useQuery<UnitPlc[]>({
    queryKey: ['unit-plcs', id, pricingUnitId],
    queryFn: () => api(`/projects/${id}/units/${pricingUnitId}/plcs`),
    enabled: !!id && !!pricingUnitId,
  });
  // Distinct STAGE_LINKED milestones currently unraised somewhere in this
  // project. See internal plan construction-linked-demand-fix.md §6.1.
  const { data: pendingStages } = useQuery<
    Array<{ templateId: string; milestoneSeq: number; label: string; pendingCount: number }>
  >({
    queryKey: ['stage-raises-pending', id],
    queryFn: () => api(`/projects/${id}/stage-raises/pending`),
    enabled: !!id,
  });
  const { data: unitCharges } = useQuery<UnitCharge[]>({
    queryKey: ['unit-charges', id, pricingUnitId],
    queryFn: () => api(`/projects/${id}/units/${pricingUnitId}/charges`),
    enabled: !!id && !!pricingUnitId,
  });

  const { data: projectMedia } = useQuery<ProjectMediaItem[]>({
    queryKey: ['project-media', id],
    queryFn: () => api(`/projects/${id}/media`),
    enabled: !!id,
  });

  const { data: constructionUpdates } = useQuery<ConstructionUpdateItem[]>({
    queryKey: ['construction-updates', id],
    queryFn: () => api(`/admin/construction-updates?projectId=${id}`),
    enabled: !!id,
  });

  const { data: projectTypes } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'project-types', 'all'],
    queryFn: () => api('/masters/project-types?limit=100'),
    enabled: showEditForm,
  });
  const { data: areaLocations } = useQuery<{ data: MasterOption[] }>({
    queryKey: ['masters', 'area-locations', 'all'],
    queryFn: () => api('/masters/area-locations?limit=100'),
    enabled: showEditForm,
  });
  // Cheap count, fetched only while the edit form is open — drives whether
  // an areaLocationId change needs the GST-consequence confirmation below.
  const { data: bookingCountRes } = useQuery<{ count: number }>({
    queryKey: ['project-booking-count', id],
    queryFn: () => api(`/projects/${id}/booking-count`),
    enabled: !!id && showEditForm,
  });

  const handleOpenEdit = () => {
    if (!project) return;
    setEditName(project.name);
    setEditReraNumber(project.reraNumber ?? '');
    setEditProjectTypeId(project.projectTypeId ?? '');
    setEditAreaLocationId(project.areaLocationId ?? '');
    setEditAddress(project.address ?? '');
    setEditDescription(project.description ?? '');
    setEditStartDate(project.startDate ? project.startDate.slice(0, 10) : '');
    setEditExpectedEndDate(project.expectedEndDate ? project.expectedEndDate.slice(0, 10) : '');
    setEditCustomFieldValues(project.customFields ?? {});
    setEditError('');
    setShowAreaChangeConfirm(false);
    setShowEditForm(true);
  };

  const submitEdit = async () => {
    setEditError('');
    try {
      await api(`/projects/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName,
          reraNumber: editReraNumber.trim() === '' ? undefined : editReraNumber.trim(),
          projectTypeId: editProjectTypeId === '' ? undefined : editProjectTypeId,
          areaLocationId: editAreaLocationId === '' ? undefined : editAreaLocationId,
          address: editAddress.trim() === '' ? undefined : editAddress.trim(),
          description: editDescription.trim() === '' ? undefined : editDescription.trim(),
          startDate: editStartDate === '' ? undefined : editStartDate,
          expectedEndDate: editExpectedEndDate === '' ? undefined : editExpectedEndDate,
          customFields: buildCustomFieldPayload(projectDefs, editCustomFieldValues),
        }),
      });
      qc.invalidateQueries({ queryKey: ['project', id] });
      setShowEditForm(false);
      setShowAreaChangeConfirm(false);
    } catch (err) {
      setEditError((err as Error).message);
    }
  };

  const handleSaveEdit = async () => {
    const areaChanged = project != null && editAreaLocationId !== (project.areaLocationId ?? '');
    if (areaChanged && (bookingCountRes?.count ?? 0) > 0 && !showAreaChangeConfirm) {
      setShowAreaChangeConfirm(true);
      return;
    }
    await submitEdit();
  };

  const addPlcMutation = useApiMutation<UnitPlc, Record<string, unknown>>(
    'POST',
    `/projects/${id}/units/${pricingUnitId}/plcs`,
    [['unit-plcs', id ?? '', pricingUnitId ?? '']],
  );
  const removePlcMutation = useApiMutation<unknown, { plcId: string }>(
    'DELETE',
    (body) => `/projects/${id}/units/${pricingUnitId}/plcs/${body.plcId}`,
    [['unit-plcs', id ?? '', pricingUnitId ?? '']],
  );
  const addChargeMutation = useApiMutation<UnitCharge, Record<string, unknown>>(
    'POST',
    `/projects/${id}/units/${pricingUnitId}/charges`,
    [['unit-charges', id ?? '', pricingUnitId ?? '']],
  );
  const removeChargeMutation = useApiMutation<unknown, { chargeId: string }>(
    'DELETE',
    (body) => `/projects/${id}/units/${pricingUnitId}/charges/${body.chargeId}`,
    [['unit-charges', id ?? '', pricingUnitId ?? '']],
  );

  const handleAddPlc = async () => {
    setPricingError('');
    try {
      await addPlcMutation.mutateAsync({ plcTypeId: newPlcTypeId, percentage: Number(newPlcPercentage) });
      setNewPlcTypeId('');
      setNewPlcPercentage('');
    } catch (err) {
      setPricingError((err as Error).message);
    }
  };

  const handleAddCharge = async () => {
    setPricingError('');
    try {
      await addChargeMutation.mutateAsync({
        chargeTypeId: newChargeTypeId,
        amountPaise: String(Math.round(Number(newChargeAmountRupees) * 100)),
      });
      setNewChargeTypeId('');
      setNewChargeAmountRupees('');
    } catch (err) {
      setPricingError((err as Error).message);
    }
  };

  const handleUploadMedia = async () => {
    setMediaError('');
    if (!mediaFile) {
      setMediaError('Choose a file first');
      return;
    }
    try {
      const formData = new FormData();
      formData.append('category', mediaCategory);
      formData.append('file', mediaFile);
      await api(`/projects/${id}/media`, { method: 'POST', body: formData });
      setMediaFile(null);
      qc.invalidateQueries({ queryKey: ['project-media', id] });
    } catch (err) {
      setMediaError((err as Error).message);
    }
  };

  const handleDeleteMedia = async (mediaId: string) => {
    await api(`/projects/${id}/media/${mediaId}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['project-media', id] });
  };

  const handleCreateUpdate = async () => {
    setUpdateError('');
    if (!newUpdateTitle.trim() || !newUpdatePublishedAt) {
      setUpdateError('Title and date are required');
      return;
    }
    try {
      await api('/admin/construction-updates', {
        method: 'POST',
        body: JSON.stringify({
          projectId: id,
          title: newUpdateTitle.trim(),
          description: newUpdateDescription.trim() === '' ? undefined : newUpdateDescription.trim(),
          publishedAt: newUpdatePublishedAt,
        }),
      });
      setNewUpdateTitle('');
      setNewUpdateDescription('');
      setNewUpdatePublishedAt('');
      qc.invalidateQueries({ queryKey: ['construction-updates', id] });
    } catch (err) {
      setUpdateError((err as Error).message);
    }
  };

  const handleAddUpdatePhoto = async (updateId: string) => {
    const file = updatePhotoFiles[updateId];
    if (!file) return;
    setUpdateError('');
    try {
      const formData = new FormData();
      formData.append('file', file);
      await api(`/admin/construction-updates/${updateId}/media`, { method: 'POST', body: formData });
      setUpdatePhotoFiles((prev) => ({ ...prev, [updateId]: null }));
      qc.invalidateQueries({ queryKey: ['construction-updates', id] });
    } catch (err) {
      setUpdateError((err as Error).message);
    }
  };

  const handleDeleteUpdate = async (updateId: string) => {
    await api(`/admin/construction-updates/${updateId}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['construction-updates', id] });
  };

  const handleRaiseStage = async () => {
    if (!raisingStage) return;
    setStageRaiseError('');
    setStageRaiseResult('');
    try {
      const res = await api<{ raisedCount: number }>(`/projects/${id}/stage-raises`, {
        method: 'POST',
        body: JSON.stringify({
          templateId: raisingStage.templateId,
          milestoneSeq: raisingStage.milestoneSeq,
          stageCompletedOn,
        }),
      });
      setStageRaiseResult(
        `${res.raisedCount} installment${res.raisedCount === 1 ? '' : 's'} raised for "${raisingStage.label}".`,
      );
      setRaisingStage(null);
      qc.invalidateQueries({ queryKey: ['stage-raises-pending', id] });
    } catch (err) {
      setStageRaiseError((err as Error).message);
    }
  };

  const createTowerMutation = useApiMutation<Tower, Record<string, unknown>>(
    'POST',
    `/projects/${id}/towers`,
    [['towers', id ?? '']],
  );

  const handleCreateTower = async () => {
    setTowerError('');
    try {
      await createTowerMutation.mutateAsync({ name: towerName, code: towerCode, totalFloors: Number(towerFloors) });
      setShowTowerForm(false);
      setTowerName('');
      setTowerCode('');
      setTowerFloors('1');
    } catch (err) {
      setTowerError((err as Error).message);
    }
  };

  const handleBulkGenerate = async () => {
    setBulkError('');
    try {
      const body: Record<string, unknown> = {
        towerId: bulkTowerId,
        floorStart: Number(floorStart),
        floorEnd: Number(floorEnd),
        unitsPerFloor: Number(unitsPerFloor),
        unitPrefix,
        baseRatePaise: baseRateRupees.trim() === '' ? undefined : String(Math.round(Number(baseRateRupees) * 100)),
        unitTypeId: unitTypeId === '' ? undefined : unitTypeId,
        carpetAreaSqft: carpetAreaSqft.trim() === '' ? undefined : Number(carpetAreaSqft),
      };
      await api(`/projects/${id}/units/bulk-generate`, { method: 'POST', body: JSON.stringify(body) });
      qc.invalidateQueries({ queryKey: ['units', id] });
      setShowBulkForm(false);
    } catch (err) {
      setBulkError((err as Error).message);
    }
  };

  const handleCreateGroup = async () => {
    setGroupError('');
    try {
      await api(`/projects/${id}/inventory-groups`, {
        method: 'POST',
        body: JSON.stringify({
          name: groupName,
          code: groupCode,
          kind: groupKind.trim() === '' ? undefined : groupKind.trim(),
        }),
      });
      qc.invalidateQueries({ queryKey: ['inventory-groups', id] });
      setShowGroupForm(false);
      setGroupName('');
      setGroupCode('');
      setGroupKind('');
    } catch (err) {
      setGroupError((err as Error).message);
    }
  };

  const handleDeactivateGroup = async (groupId: string) => {
    await api(`/inventory-groups/${groupId}`, { method: 'DELETE' });
    qc.invalidateQueries({ queryKey: ['inventory-groups', id] });
  };

  const handleOpenLandUnitForm = () => {
    if (!project) return;
    setLandUnitError('');
    setLandUnitNumber('');
    setLandUnitGroupId('');
    setLandUnitTypeId('');
    setLandAreaEntered('');
    setLandAreaEnteredUnit(project.landAreaDefaultUnit ?? 'ACRE');
    setLandRateUnit(project.landAreaDefaultUnit ?? 'ACRE');
    setLandBaseRateRupees('');
    setLandBuiltUpAreaSqft('');
    setLandBuiltUpRateRupees('');
    setLandRecordRef('');
    setLandFacing('');
    setLandLengthFeet('');
    setLandBreadthFeet('');
    setShowLandUnitForm(true);
  };

  const handleCreateLandUnit = async () => {
    setLandUnitError('');
    try {
      await api(`/projects/${id}/units/land-based`, {
        method: 'POST',
        body: JSON.stringify({
          number: landUnitNumber,
          inventoryGroupId: landUnitGroupId === '' ? undefined : landUnitGroupId,
          unitTypeId: landUnitTypeId === '' ? undefined : landUnitTypeId,
          landAreaEntered: Number(landAreaEntered),
          landAreaEnteredUnit,
          rateUnit: landRateUnit,
          baseRatePaise: landBaseRateRupees.trim() === '' ? undefined : String(Math.round(Number(landBaseRateRupees) * 100)),
          builtUpAreaSqft: landBuiltUpAreaSqft.trim() === '' ? undefined : Number(landBuiltUpAreaSqft),
          builtUpRatePaise: landBuiltUpRateRupees.trim() === '' ? undefined : String(Math.round(Number(landBuiltUpRateRupees) * 100)),
          landRecordRef: landRecordRef.trim() === '' ? undefined : landRecordRef.trim(),
          facing: landFacing.trim() === '' ? undefined : landFacing.trim(),
          lengthFeet: landLengthFeet.trim() === '' ? undefined : Number(landLengthFeet),
          breadthFeet: landBreadthFeet.trim() === '' ? undefined : Number(landBreadthFeet),
        }),
      });
      qc.invalidateQueries({ queryKey: ['units', id] });
      // A grouped plot changes the group's own displayed plot count.
      qc.invalidateQueries({ queryKey: ['inventory-groups', id] });
      setShowLandUnitForm(false);
    } catch (err) {
      setLandUnitError((err as Error).message);
    }
  };

  const handleDownloadTemplate = () => {
    downloadFile(`/projects/${id}/units/import-template`, `unit-import-template-${project?.code ?? id}.xlsx`);
  };

  const handleImportUnits = async () => {
    setImportError('');
    setImportResult(null);
    if (!importFile) {
      setImportError('Choose a file first');
      return;
    }
    try {
      const formData = new FormData();
      formData.append('file', importFile);
      const result = await api<typeof importResult>(`/projects/${id}/units/import`, { method: 'POST', body: formData });
      setImportResult(result);
      setImportFile(null);
      qc.invalidateQueries({ queryKey: ['units', id] });
      qc.invalidateQueries({ queryKey: ['inventory-groups', id] });
    } catch (err) {
      setImportError((err as Error).message);
    }
  };

  const toggleUnit = (unitId: string) => {
    setSelectedUnitIds((prev) => {
      const next = new Set(prev);
      if (next.has(unitId)) next.delete(unitId);
      else next.add(unitId);
      return next;
    });
  };

  const handleRateRevision = async () => {
    setRevisionError('');
    try {
      await api(`/projects/${id}/units/change-rate`, {
        method: 'POST',
        body: JSON.stringify({
          unitIds: Array.from(selectedUnitIds),
          ratePaise: String(Math.round(Number(revisionRateRupees) * 100)),
          effectiveFrom: revisionEffectiveFrom,
          reason: revisionReason,
        }),
      });
      qc.invalidateQueries({ queryKey: ['units', id] });
      setSelectedUnitIds(new Set());
      setRevisionRateRupees('');
      setRevisionEffectiveFrom('');
      setRevisionReason('');
    } catch (err) {
      setRevisionError((err as Error).message);
    }
  };

  if (!project) return <div className="text-slate-500">Loading…</div>;

  return (
    <div>
      {!showEditForm ? (
        <>
          <div className="flex items-start justify-between">
            <div>
              <h1 className="page-title">{project.name}</h1>
              <p className="text-sm text-slate-500">
                Code: {project.code} {project.reraNumber && <>· RERA: {project.reraNumber}</>}
              </p>
              {project.address && <p className="text-sm text-slate-500">{project.address}</p>}
            </div>
            <button
              onClick={handleOpenEdit}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Edit Project
            </button>
          </div>
          <CustomFieldDisplay definitions={projectDefs} values={project.customFields} />
        </>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="section-title">Edit Project</h2>
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-slate-700">Name</label>
              <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Code</label>
              <input type="text" value={project.code} disabled className="mt-1 block w-full rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-500" />
              <p className="mt-1 text-xs text-slate-500">
                Cannot be changed — bulk inquiry import matches projects to this code, so changing it would break existing CSV mappings.
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">RERA Number</label>
              <input type="text" value={editReraNumber} onChange={(e) => setEditReraNumber(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Project Type</label>
              <select value={editProjectTypeId} onChange={(e) => setEditProjectTypeId(e.target.value)} className="mt-1 input">
                <option value="">Select…</option>
                {projectTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Area/Location</label>
              <select value={editAreaLocationId} onChange={(e) => setEditAreaLocationId(e.target.value)} className="mt-1 input">
                <option value="">Select…</option>
                {areaLocations?.data?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <p className="mt-1 text-xs text-slate-500">Drives GST place-of-supply for new bookings only — existing bookings keep their original rate.</p>
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700">Address</label>
              <input type="text" value={editAddress} onChange={(e) => setEditAddress(e.target.value)} className="mt-1 input" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-slate-700">Description</label>
              <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={3} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Start Date</label>
              <input type="date" value={editStartDate} onChange={(e) => setEditStartDate(e.target.value)} className="mt-1 input" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700">Expected End Date</label>
              <input type="date" value={editExpectedEndDate} onChange={(e) => setEditExpectedEndDate(e.target.value)} className="mt-1 input" />
            </div>
          </div>
          <CustomFieldInputs
            definitions={projectDefs}
            values={editCustomFieldValues}
            onChange={(key, value) => setEditCustomFieldValues((prev) => ({ ...prev, [key]: value }))}
          />

          {showAreaChangeConfirm && (
            <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm text-amber-900">
                This project has {bookingCountRes?.count} existing booking{bookingCountRes?.count === 1 ? '' : 's'}. Their
                GST is already locked to the current location and will not change. New bookings after this save will use
                the new location&apos;s state code for GST. Continue?
              </p>
              <div className="mt-3 flex gap-3">
                <button onClick={submitEdit} className="rounded-md bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700">
                  Yes, save
                </button>
                <button onClick={() => setShowAreaChangeConfirm(false)} className="btn btn-md btn-secondary">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {!showAreaChangeConfirm && (
            <div className="mt-3 flex gap-3">
              <button onClick={handleSaveEdit} className="btn btn-md btn-primary">
                Save
              </button>
              <button onClick={() => setShowEditForm(false)} className="btn btn-md btn-secondary">
                Cancel
              </button>
            </div>
          )}
          {editError && <p className="mt-2 text-sm text-red-600">{editError}</p>}
        </div>
      )}

      {project.shape === 'HIGH_RISE' ? (
        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="section-title">Towers</h2>
            <button onClick={() => setShowTowerForm(true)} className="btn btn-primary px-3 py-1.5 text-sm">
              Add Tower
            </button>
          </div>
          {showTowerForm && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700">Name</label>
                  <input type="text" value={towerName} onChange={(e) => setTowerName(e.target.value)} className="mt-1 input" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700">Code</label>
                  <input type="text" value={towerCode} onChange={(e) => setTowerCode(e.target.value)} className="mt-1 input" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700">Total Floors</label>
                  <input type="number" value={towerFloors} onChange={(e) => setTowerFloors(e.target.value)} className="mt-1 input" />
                </div>
              </div>
              <div className="mt-3 flex gap-3">
                <button onClick={handleCreateTower} className="btn btn-md btn-primary">Create</button>
                <button onClick={() => setShowTowerForm(false)} className="btn btn-md btn-secondary">Cancel</button>
              </div>
              {towerError && <p className="mt-2 text-sm text-red-600">{towerError}</p>}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {towers?.map((t) => (
              <span key={t.id} className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">
                {t.name} ({t.code}) — {t._count?.floors ?? 0} floors
              </span>
            ))}
          </div>
        </section>
      ) : (
        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="section-title">Inventory Groups</h2>
            <button onClick={() => setShowGroupForm(true)} className="btn btn-primary px-3 py-1.5 text-sm">
              Add Group
            </button>
          </div>
          <p className="mt-1 text-xs text-slate-500">Sector / Block / Cluster — optional. Plots can also be left ungrouped.</p>
          {showGroupForm && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700">Name</label>
                  <input type="text" value={groupName} onChange={(e) => setGroupName(e.target.value)} className="mt-1 input" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700">Code</label>
                  <input type="text" value={groupCode} onChange={(e) => setGroupCode(e.target.value)} className="mt-1 input" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700">Kind (e.g. Sector, Block)</label>
                  <input type="text" value={groupKind} onChange={(e) => setGroupKind(e.target.value)} className="mt-1 input" />
                </div>
              </div>
              <div className="mt-3 flex gap-3">
                <button onClick={handleCreateGroup} className="btn btn-md btn-primary">Create</button>
                <button onClick={() => setShowGroupForm(false)} className="btn btn-md btn-secondary">Cancel</button>
              </div>
              {groupError && <p className="mt-2 text-sm text-red-600">{groupError}</p>}
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {groups?.filter((g) => g.isActive).map((g) => (
              <span key={g.id} className="flex items-center gap-2 rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">
                {g.name} ({g.code}){g.kind ? ` — ${g.kind}` : ''} — {g._count?.units ?? 0} plots
                <button onClick={() => handleDeactivateGroup(g.id)} className="text-xs text-red-600 hover:text-red-800">✕</button>
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="mt-6">
        <div className="flex items-center justify-between">
          <h2 className="section-title">{project.shape === 'HIGH_RISE' ? 'Units' : 'Plots'}</h2>
          {project.shape === 'HIGH_RISE' ? (
            <button onClick={() => setShowBulkForm(true)} className="btn btn-primary px-3 py-1.5 text-sm">
              Bulk-Generate Units
            </button>
          ) : (
            <button onClick={handleOpenLandUnitForm} className="btn btn-primary px-3 py-1.5 text-sm">
              Add Plot
            </button>
          )}
        </div>

        {project.shape === 'LAND_BASED' && showLandUnitForm && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700">Plot Number</label>
                <input type="text" value={landUnitNumber} onChange={(e) => setLandUnitNumber(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Group (optional)</label>
                <select value={landUnitGroupId} onChange={(e) => setLandUnitGroupId(e.target.value)} className="mt-1 input">
                  <option value="">Ungrouped</option>
                  {groups?.filter((g) => g.isActive).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Unit Type</label>
                <select value={landUnitTypeId} onChange={(e) => setLandUnitTypeId(e.target.value)} className="mt-1 input">
                  <option value="">Select…</option>
                  {unitTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Land Area Entered</label>
                <input type="number" step="any" value={landAreaEntered} onChange={(e) => setLandAreaEntered(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Land Area Unit</label>
                <select value={landAreaEnteredUnit} onChange={(e) => setLandAreaEnteredUnit(e.target.value as AreaUnit)} className="mt-1 input">
                  {AREA_UNITS.map((u) => <option key={u} value={u}>{displayLabel(u)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Rate Unit</label>
                <select value={landRateUnit} onChange={(e) => setLandRateUnit(e.target.value as AreaUnit)} className="mt-1 input">
                  {AREA_UNITS.map((u) => <option key={u} value={u}>{displayLabel(u)}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Base Rate (₹ per Rate Unit)</label>
                <input type="number" value={landBaseRateRupees} onChange={(e) => setLandBaseRateRupees(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Land Record Ref</label>
                <input type="text" value={landRecordRef} onChange={(e) => setLandRecordRef(e.target.value)} placeholder="Khasra / survey no." className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Facing</label>
                <input type="text" value={landFacing} onChange={(e) => setLandFacing(e.target.value)} placeholder="e.g. North-East" className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Length (feet)</label>
                <input type="number" value={landLengthFeet} onChange={(e) => setLandLengthFeet(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Breadth (feet)</label>
                <input type="number" value={landBreadthFeet} onChange={(e) => setLandBreadthFeet(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Built-up Area (sqft, farmhouse only)</label>
                <input type="number" value={landBuiltUpAreaSqft} onChange={(e) => setLandBuiltUpAreaSqft(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Built-up Rate (₹/sqft)</label>
                <input type="number" value={landBuiltUpRateRupees} onChange={(e) => setLandBuiltUpRateRupees(e.target.value)} className="mt-1 input" />
              </div>
            </div>
            <div className="mt-3 flex gap-3">
              <button onClick={handleCreateLandUnit} className="btn btn-md btn-primary">Create</button>
              <button onClick={() => setShowLandUnitForm(false)} className="btn btn-md btn-secondary">Cancel</button>
            </div>
            {landUnitError && <p className="mt-2 text-sm text-red-600">{landUnitError}</p>}
          </div>
        )}

        {project.shape === 'HIGH_RISE' && showBulkForm && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700">Tower</label>
                <select value={bulkTowerId} onChange={(e) => setBulkTowerId(e.target.value)} className="mt-1 input">
                  <option value="">Select…</option>
                  {towers?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Floor Start</label>
                <input type="number" value={floorStart} onChange={(e) => setFloorStart(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Floor End</label>
                <input type="number" value={floorEnd} onChange={(e) => setFloorEnd(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Units Per Floor</label>
                <input type="number" value={unitsPerFloor} onChange={(e) => setUnitsPerFloor(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Unit Prefix</label>
                <input type="text" value={unitPrefix} onChange={(e) => setUnitPrefix(e.target.value)} placeholder="e.g. A-" className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Unit Type</label>
                <select value={unitTypeId} onChange={(e) => setUnitTypeId(e.target.value)} className="mt-1 input">
                  <option value="">Select…</option>
                  {unitTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Carpet Area (sqft)</label>
                <input type="number" value={carpetAreaSqft} onChange={(e) => setCarpetAreaSqft(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Base Rate (₹)</label>
                <input type="number" value={baseRateRupees} onChange={(e) => setBaseRateRupees(e.target.value)} className="mt-1 input" />
              </div>
            </div>
            <div className="mt-3 flex gap-3">
              <button onClick={handleBulkGenerate} className="btn btn-md btn-primary">Generate</button>
              <button onClick={() => setShowBulkForm(false)} className="btn btn-md btn-secondary">Cancel</button>
            </div>
            {bulkError && <p className="mt-2 text-sm text-red-600">{bulkError}</p>}
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-3">
          {project.shape === 'HIGH_RISE' ? (
            <>
              <label className="text-sm font-medium text-slate-700">Filter by Tower</label>
              <select value={selectedTowerFilter} onChange={(e) => setSelectedTowerFilter(e.target.value)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">
                <option value="">All towers</option>
                {towers?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </>
          ) : (
            <>
              <label className="text-sm font-medium text-slate-700">Filter by Group</label>
              <select value={selectedGroupFilter} onChange={(e) => setSelectedGroupFilter(e.target.value)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">
                <option value="">All plots</option>
                {groups?.filter((g) => g.isActive).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </>
          )}
          <label className="text-sm font-medium text-slate-700">Status</label>
          <select value={unitStatusFilter} onChange={(e) => setUnitStatusFilter(e.target.value)} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm">
            <option value="">Any status</option>
            {['AVAILABLE', 'HELD', 'BLOCKED', 'BOOKED', 'ALLOTTED', 'REGISTERED', 'CANCELLED'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>

        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-slate-50">
              <tr>
                <th className="px-4 py-3"></th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">{project.shape === 'HIGH_RISE' ? 'Unit Number' : 'Plot Number'}</th>
                {project.shape === 'LAND_BASED' && (
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Group</th>
                )}
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Rate</th>
                {project.shape === 'HIGH_RISE' ? (
                  <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Carpet Area</th>
                ) : (
                  <>
                    <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Land Area</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-slate-500 uppercase">Facing</th>
                  </>
                )}
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {unitsLoading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">Loading…</td></tr>
              ) : (units?.data ?? []).length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-slate-500">No {project.shape === 'HIGH_RISE' ? 'units' : 'plots'} yet</td></tr>
              ) : (
                units!.data.map((u) => (
                  <tr key={u.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={selectedUnitIds.has(u.id)} onChange={() => toggleUnit(u.id)} className="h-4 w-4 rounded border-slate-300 text-blue-600" />
                    </td>
                    <td className="px-4 py-3 text-sm text-slate-700">{u.number}</td>
                    {project.shape === 'LAND_BASED' && (
                      <td className="px-4 py-3 text-sm text-slate-700">{u.inventoryGroup?.name ?? '—'}</td>
                    )}
                    <td className="px-4 py-3 text-sm text-slate-700">{u.status}</td>
                    <td className="px-4 py-3 text-sm text-slate-700">{rupees(u.baseRatePaise)}</td>
                    {project.shape === 'HIGH_RISE' ? (
                      <td className="px-4 py-3 text-sm text-slate-700">{u.carpetAreaSqft ?? '—'}</td>
                    ) : (
                      <>
                        <td className="px-4 py-3 text-sm text-slate-700">
                          {u.landAreaEntered && u.landAreaEnteredUnit
                            ? formatArea(toAreaScaled(u.landAreaEntered), u.landAreaEnteredUnit)
                            : '—'}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700">{u.facing ?? '—'}</td>
                      </>
                    )}
                    <td className="px-4 py-3 text-right space-x-3">
                      <button onClick={() => setHistoryUnitId(u.id)} className="text-blue-600 hover:text-blue-800 text-xs">
                        Rate History
                      </button>
                      <button onClick={() => setPricingUnitId(u.id)} className="text-blue-600 hover:text-blue-800 text-xs">
                        Pricing
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="mt-3 flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4">
          <span className="text-sm font-medium text-slate-700">Bulk import / export</span>
          <button onClick={handleDownloadTemplate} className="text-xs font-medium text-blue-600 hover:text-blue-800">
            Download template
          </button>
          <input type="file" accept=".xlsx" onChange={(e) => setImportFile(e.target.files?.[0] ?? null)} className="text-xs" />
          <button onClick={handleImportUnits} disabled={!importFile} className="btn btn-sm btn-primary">
            Import
          </button>
          <button
            onClick={() => downloadFile(`/projects/${id}/units/export`, `units-${project.code}.xlsx`)}
            className="text-xs font-medium text-blue-600 hover:text-blue-800"
          >
            Export current list
          </button>
        </div>
        {importError && <p className="mt-2 text-sm text-red-600">{importError}</p>}
        {importResult && (
          <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
            {importResult.errorCount > 0 ? (
              <>
                <p className="font-medium text-red-600">{importResult.errorCount} error(s), nothing imported</p>
                <ul className="mt-1 list-disc pl-5 text-xs">
                  {importResult.errors.map((e, i) => (
                    <li key={i}>Row {e.row}: {e.field} — {e.message}</li>
                  ))}
                </ul>
              </>
            ) : (
              <p>
                {importResult.createdCount} created
                {importResult.skippedCount > 0 ? `, ${importResult.skippedCount} skipped` : ''}.
              </p>
            )}
          </div>
        )}

        {selectedUnitIds.size > 0 && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-medium text-slate-800">
              Apply Rate Revision to {selectedUnitIds.size} selected unit{selectedUnitIds.size === 1 ? '' : 's'}
            </h3>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium text-slate-700">New Rate (₹)</label>
                <input type="number" value={revisionRateRupees} onChange={(e) => setRevisionRateRupees(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Effective From</label>
                <input type="date" value={revisionEffectiveFrom} onChange={(e) => setRevisionEffectiveFrom(e.target.value)} className="mt-1 input" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700">Reason</label>
                <input type="text" value={revisionReason} onChange={(e) => setRevisionReason(e.target.value)} className="mt-1 input" />
              </div>
            </div>
            <div className="mt-3">
              <button onClick={handleRateRevision} className="btn btn-md btn-primary">
                Apply Revision
              </button>
            </div>
            {revisionError && <p className="mt-2 text-sm text-red-600">{revisionError}</p>}
          </div>
        )}

        {historyUnitId && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-800">Rate History</h3>
              <button onClick={() => setHistoryUnitId(null)} className="text-xs text-slate-500 hover:text-slate-700">Close</button>
            </div>
            <ul className="mt-2 space-y-1 text-sm text-slate-700">
              {(rateHistory?.data ?? []).length === 0 ? (
                <li className="text-slate-500">No rate revisions yet</li>
              ) : (
                rateHistory!.data.map((r) => (
                  <li key={r.id}>
                    {rupees(r.ratePaise)} effective {new Date(r.effectiveFrom).toLocaleDateString()}
                    {r.reason && <> — {r.reason}</>}
                  </li>
                ))
              )}
            </ul>
          </div>
        )}

        {pricingUnitId && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-800">Pricing — PLCs and extra charges</h3>
              <button onClick={() => setPricingUnitId(null)} className="text-xs text-slate-500 hover:text-slate-700">Close</button>
            </div>
            {pricingError && <p className="mt-2 text-sm text-red-600">{pricingError}</p>}

            <div className="mt-3">
              <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">PLCs</h4>
              <ul className="mt-1 space-y-1 text-sm text-slate-700">
                {(unitPlcs ?? []).length === 0 ? (
                  <li className="text-slate-500">None assigned</li>
                ) : (
                  unitPlcs!.map((p) => (
                    <li key={p.id} className="flex items-center justify-between">
                      <span>
                        {p.plcType.name} — {rupees(p.amountPaise)}
                        {p.percentage && ` (${p.percentage}%)`}
                      </span>
                      <button
                        onClick={() => removePlcMutation.mutate({ plcId: p.id })}
                        className="text-xs text-red-600 hover:text-red-800"
                      >
                        Remove
                      </button>
                    </li>
                  ))
                )}
              </ul>
              <div className="mt-2 flex items-end gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">PLC Type</label>
                  <select value={newPlcTypeId} onChange={(e) => setNewPlcTypeId(e.target.value)} className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                    <option value="">Select…</option>
                    {plcTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Percentage of base rate</label>
                  <input type="number" value={newPlcPercentage} onChange={(e) => setNewPlcPercentage(e.target.value)} className="mt-1 w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                </div>
                <button onClick={handleAddPlc} disabled={!newPlcTypeId || !newPlcPercentage} className="btn btn-sm btn-primary">
                  Add PLC
                </button>
              </div>
            </div>

            <div className="mt-4">
              <h4 className="text-xs font-medium uppercase tracking-wide text-slate-500">Extra charges</h4>
              <ul className="mt-1 space-y-1 text-sm text-slate-700">
                {(unitCharges ?? []).length === 0 ? (
                  <li className="text-slate-500">None assigned</li>
                ) : (
                  unitCharges!.map((c) => (
                    <li key={c.id} className="flex items-center justify-between">
                      <span>{c.chargeType.name} — {rupees(c.amountPaise)}</span>
                      <button
                        onClick={() => removeChargeMutation.mutate({ chargeId: c.id })}
                        className="text-xs text-red-600 hover:text-red-800"
                      >
                        Remove
                      </button>
                    </li>
                  ))
                )}
              </ul>
              <div className="mt-2 flex items-end gap-2">
                <div>
                  <label className="block text-xs font-medium text-slate-700">Charge Type</label>
                  <select value={newChargeTypeId} onChange={(e) => setNewChargeTypeId(e.target.value)} className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm">
                    <option value="">Select…</option>
                    {chargeTypes?.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-700">Amount (₹)</label>
                  <input type="number" value={newChargeAmountRupees} onChange={(e) => setNewChargeAmountRupees(e.target.value)} className="mt-1 w-28 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                </div>
                <button onClick={handleAddCharge} disabled={!newChargeTypeId || !newChargeAmountRupees} className="btn btn-sm btn-primary">
                  Add Charge
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="mt-6">
        <h2 className="section-title">Media</h2>
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
          <ul className="space-y-1 text-sm text-slate-700">
            {(projectMedia ?? []).length === 0 ? (
              <li className="text-slate-500">No layout plans, brochures, or photos yet</li>
            ) : (
              projectMedia!.map((m) => (
                <li key={m.id} className="flex items-center justify-between">
                  <span>
                    <span className="mr-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600">
                      {MEDIA_CATEGORY_LABELS[m.category] ?? m.category}
                    </span>
                    {m.originalName}
                  </span>
                  <span className="space-x-3">
                    <button
                      onClick={() => downloadFile(`/projects/${id}/media/${m.id}/download`, m.originalName)}
                      className="text-xs text-blue-600 hover:text-blue-800"
                    >
                      Download
                    </button>
                    <button onClick={() => handleDeleteMedia(m.id)} className="text-xs text-red-600 hover:text-red-800">
                      Delete
                    </button>
                  </span>
                </li>
              ))
            )}
          </ul>
          <div className="mt-3 flex items-end gap-2">
            <div>
              <label className="block text-xs font-medium text-slate-700">Category</label>
              <select
                value={mediaCategory}
                onChange={(e) => setMediaCategory(e.target.value as typeof mediaCategory)}
                className="mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
              >
                <option value="layout_plan">Layout Plan</option>
                <option value="brochure">Brochure</option>
                <option value="photo">Photo</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">File</label>
              <input type="file" onChange={(e) => setMediaFile(e.target.files?.[0] ?? null)} className="mt-1 block text-sm" />
            </div>
            <button
              onClick={handleUploadMedia}
              disabled={!mediaFile}
              className="btn btn-sm btn-primary"
            >
              Upload
            </button>
          </div>
          {mediaError && <p className="mt-2 text-sm text-red-600">{mediaError}</p>}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="section-title">Construction Updates</h2>
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
          <ul className="space-y-3 text-sm text-slate-700">
            {(constructionUpdates ?? []).length === 0 ? (
              <li className="text-slate-500">No construction updates published yet</li>
            ) : (
              constructionUpdates!.map((u) => (
                <li key={u.id} className="rounded-md border border-slate-100 p-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="font-medium text-slate-800">{u.title}</div>
                      <div className="text-xs text-slate-500">{u.publishedAt.slice(0, 10)}</div>
                      {u.description && <p className="mt-1 text-slate-600">{u.description}</p>}
                    </div>
                    <button onClick={() => handleDeleteUpdate(u.id)} className="text-xs text-red-600 hover:text-red-800">
                      Delete
                    </button>
                  </div>
                  {u.media.length > 0 && (
                    <ul className="mt-2 space-y-1">
                      {u.media.map((m) => (
                        <li key={m.id}>
                          <button
                            onClick={() => downloadFile(`/admin/construction-updates/media/${m.id}/download`, m.originalName)}
                            className="text-xs text-blue-600 hover:text-blue-800"
                          >
                            {m.originalName}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="file"
                      onChange={(e) =>
                        setUpdatePhotoFiles((prev) => ({ ...prev, [u.id]: e.target.files?.[0] ?? null }))
                      }
                      className="block text-xs"
                    />
                    <button
                      onClick={() => handleAddUpdatePhoto(u.id)}
                      disabled={!updatePhotoFiles[u.id]}
                      className="rounded-md bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      Add Photo
                    </button>
                  </div>
                </li>
              ))
            )}
          </ul>
          <div className="mt-4 grid grid-cols-1 gap-2 border-t border-slate-100 pt-3 sm:grid-cols-4 sm:items-end">
            <div>
              <label className="block text-xs font-medium text-slate-700">Title</label>
              <input
                value={newUpdateTitle}
                onChange={(e) => setNewUpdateTitle(e.target.value)}
                className="mt-1 input px-2 py-1.5"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Description</label>
              <input
                value={newUpdateDescription}
                onChange={(e) => setNewUpdateDescription(e.target.value)}
                className="mt-1 input px-2 py-1.5"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700">Date</label>
              <input
                type="date"
                value={newUpdatePublishedAt}
                onChange={(e) => setNewUpdatePublishedAt(e.target.value)}
                className="mt-1 input px-2 py-1.5"
              />
            </div>
            <button
              onClick={handleCreateUpdate}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
            >
              Publish Update
            </button>
          </div>
          {updateError && <p className="mt-2 text-sm text-red-600">{updateError}</p>}
        </div>
      </section>

      <section>
        <h2 className="section-title">Construction Stages</h2>
        <p className="mt-1 text-sm text-slate-500">
          A stage becomes due for every booking on it at once, when marked complete here — not before.
          See the installment schedule for what "not yet due" means until then.
        </p>
        <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
          {!pendingStages || pendingStages.length === 0 ? (
            <p className="text-sm text-slate-500">No unraised construction stages in this project.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {pendingStages.map((s) => (
                <li key={`${s.templateId}-${s.milestoneSeq}`} className="flex items-center justify-between gap-2 py-2">
                  <span className="text-sm text-slate-700">
                    {s.label} — {s.pendingCount} booking{s.pendingCount === 1 ? '' : 's'} waiting
                  </span>
                  <button
                    onClick={() => {
                      setRaisingStage({ templateId: s.templateId, milestoneSeq: s.milestoneSeq, label: s.label });
                      setStageRaiseError('');
                    }}
                    className="rounded-md bg-slate-800 px-3 py-1 text-xs font-medium text-white hover:bg-slate-700"
                  >
                    Mark stage complete
                  </button>
                </li>
              ))}
            </ul>
          )}
          {stageRaiseResult && <p className="mt-2 text-sm text-emerald-700">{stageRaiseResult}</p>}
        </div>

        {raisingStage && (
          <div className="mt-3 rounded-lg border border-slate-200 bg-white p-4">
            <h3 className="text-sm font-medium text-slate-800">Raise "{raisingStage.label}"</h3>
            <p className="mt-1 text-xs text-slate-500">
              This sets a real due date for every waiting booking on this stage. Interest can start
              accruing from that date once time passes.
            </p>
            <div className="mt-2 flex items-end gap-2">
              <div>
                <label htmlFor="stage-completed-on" className="block text-xs font-medium text-slate-700">
                  Stage completed on
                </label>
                <input
                  id="stage-completed-on"
                  type="date"
                  value={stageCompletedOn}
                  onChange={(e) => setStageCompletedOn(e.target.value)}
                  className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                />
              </div>
              <button
                onClick={handleRaiseStage}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
              >
                Confirm raise
              </button>
              <button
                onClick={() => setRaisingStage(null)}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
            </div>
            {stageRaiseError && <p className="mt-2 text-sm text-red-600">{stageRaiseError}</p>}
          </div>
        )}
      </section>
    </div>
  );
}
