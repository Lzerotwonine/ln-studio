import {
  AlertTriangle,
  ArrowRight,
  Check,
  Code2,
  Copy,
  Download,
  GitMerge,
  Lock,
  MessageSquareQuote,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  Unlock,
  Users,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActionMenu } from '../components/ActionMenu'
import {
  approveRelationship,
  createCharacter,
  createRelationship,
  deleteCharacter,
  deleteRelationship,
  extractErrorMessage,
  fetchContinuityStatus,
  fetchContinuityXml,
  fetchRelationships,
  fetchVolumeCharacters,
  getContinuityXmlDownloadUrl,
  runMapPhaseApi,
  runReducePhaseApi,
  updateCharacter,
  updateRelationship,
  upsertVolumeCharacterState,
} from '../lib/api'
import type {
  CharacterAppearance,
  CharacterWithState,
  ContinuityStatus,
  RelationshipItem,
  Series,
  Volume,
} from '../types'
import {
  CHARACTER_ARCHETYPES,
  COMMON_PRONOUN_PAIRS,
  formatVolumeLabel,
} from '../types'

interface ContinuityTabProps {
  selectedSeries: Series | null
  selectedVolume: Volume | null
  onBackToDashboard: () => void
}

type ContinuitySubTab = 'roster' | 'review' | 'xml'
type ReviewFilter = 'needs_review' | 'missing_reverse' | 'locked' | 'all'

export function ContinuityTab({
  selectedSeries,
  selectedVolume,
  onBackToDashboard,
}: ContinuityTabProps) {
  const [subTab, setSubTab] = useState<ContinuitySubTab>('review')

  const [statusInfo, setStatusInfo] = useState<ContinuityStatus | null>(null)
  const [characters, setCharacters] = useState<CharacterWithState[]>([])
  const [relationships, setRelationships] = useState<RelationshipItem[]>([])
  const [xmlContent, setXmlContent] = useState('')
  const [loading, setLoading] = useState(false)
  const loadSeqRef = useRef(0)

  // Pipeline buttons
  const [runningMap, setRunningMap] = useState(false)
  const [runningReduce, setRunningReduce] = useState(false)

  // Review Queue filters & drafts
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>('needs_review')
  const [pairDrafts, setPairDrafts] = useState<Record<number, string>>({})
  const [noteDrafts, setNoteDrafts] = useState<Record<number, string>>({})

  // Modals
  const [charModalOpen, setCharModalOpen] = useState(false)
  const [newCharForm, setNewCharForm] = useState({
    canonical_name: '',
    display_name: '',
    aliases: '',
    archetype: 'NORMAL',
    default_pair: 'Tôi-Cậu',
    rtas_baseline: 3.5,
    appearance: 'ACTUAL' as CharacterAppearance,
  })

  const [relModalOpen, setRelModalOpen] = useState(false)
  const [newRelForm, setNewRelForm] = useState({
    source_char_id: 0,
    target_char_id: 0,
    pair_pronoun: 'Tôi-Cậu',
    notes: '',
    evidence_quote: '',
    is_locked: false,
  })

  // Feedback
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [toastMsg, setToastMsg] = useState<string | null>(null)

  const notify = (msg: string) => {
    setToastMsg(msg)
    window.setTimeout(() => {
      setToastMsg((curr) => (curr === msg ? null : curr))
    }, 4500)
  }

  const seriesId = selectedSeries?.id ?? null
  const volumeId = selectedVolume?.id ?? null

  const loadAll = useCallback(async () => {
    const seq = ++loadSeqRef.current
    if (!seriesId || !volumeId) {
      setStatusInfo(null)
      setCharacters([])
      setRelationships([])
      setXmlContent('')
      setPairDrafts({})
      setNoteDrafts({})
      return
    }
    setLoading(true)
    setErrorMsg(null)
    try {
      const [st, chars, rels, xml] = await Promise.all([
        fetchContinuityStatus(volumeId),
        fetchVolumeCharacters(volumeId),
        fetchRelationships(seriesId),
        fetchContinuityXml(volumeId),
      ])
      if (seq !== loadSeqRef.current) return
      setStatusInfo(st)
      setCharacters(chars)
      setRelationships(rels)
      setXmlContent(xml)

      const nextPairs: Record<number, string> = {}
      const nextNotes: Record<number, string> = {}
      rels.forEach((r) => {
        nextPairs[r.id] = r.pair_pronoun
        nextNotes[r.id] = r.notes
      })
      setPairDrafts(nextPairs)
      setNoteDrafts(nextNotes)
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      setErrorMsg(extractErrorMessage(err))
    } finally {
      if (seq === loadSeqRef.current) {
        setLoading(false)
      }
    }
  }, [seriesId, volumeId])

  useEffect(() => {
    setStatusInfo(null)
    setCharacters([])
    setRelationships([])
    setXmlContent('')
    setPairDrafts({})
    setNoteDrafts({})
    setErrorMsg(null)
    void loadAll()
  }, [loadAll])

  const filteredRelationships = useMemo(() => {
    return relationships.filter((rel) => {
      if (reviewFilter === 'needs_review') return rel.needs_review
      if (reviewFilter === 'missing_reverse') return rel.is_missing_reverse
      if (reviewFilter === 'locked') return rel.is_locked
      return true
    })
  }, [relationships, reviewFilter])

  // ---------- Pipeline Handlers ----------

  const handleRunMap = async (forceRerun = false) => {
    if (!selectedVolume) return
    setRunningMap(true)
    setErrorMsg(null)
    try {
      const res = await runMapPhaseApi(selectedVolume.id, forceRerun)
      notify(
        `MAP PHASE hoàn tất: đã phân tích ${res.processed_chapters} chương mới, dùng lại cache ${res.skipped_cached} chương.`,
      )
      await loadAll()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setRunningMap(false)
    }
  }

  const handleRunReduce = async () => {
    if (!selectedVolume) return
    setRunningReduce(true)
    setErrorMsg(null)
    try {
      const res = await runReducePhaseApi(selectedVolume.id, false)
      notify(
        `REDUCE & MERGE xong: ${res.actual_characters} nhân vật ACTUAL, +${res.relationships_added} cặp xưng hô mới, +${res.missing_reverse_created} cảnh báo thiếu chiều ngược, bảo toàn ${res.locked_preserved} cặp đã khóa.`,
      )
      await loadAll()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    } finally {
      setRunningReduce(false)
    }
  }

  // ---------- Character Handlers ----------

  const handleAddCharacter = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedSeries || !selectedVolume) return
    setErrorMsg(null)
    try {
      const aliasesArr = newCharForm.aliases
        .split(/[|,]/)
        .map((s) => s.trim())
        .filter(Boolean)
      await createCharacter(selectedSeries.id, {
        canonical_name: newCharForm.canonical_name,
        display_name: newCharForm.display_name,
        aliases: aliasesArr,
        archetype: newCharForm.archetype,
        default_pair: newCharForm.default_pair,
        rtas_baseline: newCharForm.rtas_baseline,
        volume_id: selectedVolume.id,
        appearance: newCharForm.appearance,
      })
      setCharModalOpen(false)
      setNewCharForm({
        canonical_name: '',
        display_name: '',
        aliases: '',
        archetype: 'NORMAL',
        default_pair: 'Tôi-Cậu',
        rtas_baseline: 3.5,
        appearance: 'ACTUAL',
      })
      notify('Đã thêm nhân vật mới vào Roster.')
      await loadAll()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handlePatchCharacter = async (
    charId: number,
    patch: Parameters<typeof updateCharacter>[1],
  ) => {
    setErrorMsg(null)
    try {
      await updateCharacter(charId, patch)
      await loadAll()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handlePatchCharState = async (
    charId: number,
    patch: Parameters<typeof upsertVolumeCharacterState>[2],
  ) => {
    if (!selectedVolume) return
    setErrorMsg(null)
    try {
      await upsertVolumeCharacterState(selectedVolume.id, charId, patch)
      await loadAll()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleDeleteCharacter = async (c: CharacterWithState) => {
    if (
      !window.confirm(
        `Xóa nhân vật "${c.display_name}" và các quan hệ liên quan?`,
      )
    ) {
      return
    }
    setErrorMsg(null)
    try {
      await deleteCharacter(c.id)
      notify(`Đã xóa nhân vật "${c.display_name}".`)
      await loadAll()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  // ---------- Relationship / Review Queue Handlers ----------

  const handleApproveRel = async (rel: RelationshipItem, lockAfter: boolean) => {
    const pairVal = (pairDrafts[rel.id] ?? rel.pair_pronoun).trim()
    if (!pairVal) {
      setErrorMsg(
        `Hãy chọn hoặc nhập cặp xưng hô cho ${rel.source_name} → ${rel.target_name} trước khi duyệt.`,
      )
      return
    }
    setErrorMsg(null)
    try {
      await approveRelationship(rel.id, {
        pair_pronoun: pairVal,
        notes: noteDrafts[rel.id] ?? rel.notes,
        is_locked: lockAfter,
      })
      notify(
        lockAfter
          ? `Đã duyệt & KHÓA cặp ${rel.source_name} → ${rel.target_name} (${pairVal}).`
          : `Đã duyệt cặp ${rel.source_name} → ${rel.target_name} (${pairVal}).`,
      )
      await loadAll()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleToggleLock = async (rel: RelationshipItem) => {
    setErrorMsg(null)
    try {
      const nextLock = !rel.is_locked
      await updateRelationship(rel.id, {
        pair_pronoun: (pairDrafts[rel.id] ?? rel.pair_pronoun).trim(),
        notes: noteDrafts[rel.id] ?? rel.notes,
        is_locked: nextLock,
        needs_review: nextLock ? false : rel.needs_review,
      })
      notify(
        nextLock
          ? `Đã KHÓA cặp ${rel.source_name} → ${rel.target_name} (cố định cho các tập sau).`
          : `Đã mở khóa cặp ${rel.source_name} → ${rel.target_name}.`,
      )
      await loadAll()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleAddRelationship = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!selectedSeries || !selectedVolume) return
    if (!newRelForm.source_char_id || !newRelForm.target_char_id) {
      setErrorMsg('Hãy chọn đủ nhân vật nói và nhân vật nghe.')
      return
    }
    setErrorMsg(null)
    try {
      await createRelationship(selectedSeries.id, {
        source_char_id: newRelForm.source_char_id,
        target_char_id: newRelForm.target_char_id,
        pair_pronoun: newRelForm.pair_pronoun,
        notes: newRelForm.notes,
        evidence_quote: newRelForm.evidence_quote,
        needs_review: !newRelForm.is_locked,
        is_locked: newRelForm.is_locked,
        last_updated_vol: selectedVolume.volume_number,
      })
      setRelModalOpen(false)
      notify('Đã tạo cặp xưng hô mới.')
      await loadAll()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleDeleteRel = async (rel: RelationshipItem) => {
    if (
      !window.confirm(
        `Xóa cặp xưng hô ${rel.source_name} → ${rel.target_name}?`,
      )
    ) {
      return
    }
    setErrorMsg(null)
    try {
      await deleteRelationship(rel.id)
      notify('Đã xóa cặp quan hệ.')
      await loadAll()
    } catch (err) {
      setErrorMsg(extractErrorMessage(err))
    }
  }

  const handleCopyXml = async () => {
    try {
      await navigator.clipboard.writeText(xmlContent)
      notify('Đã sao chép XML Continuity Pack vào clipboard.')
    } catch {
      setErrorMsg('Không thể sao chép tự động, vui lòng bôi đen để copy.')
    }
  }

  if (!selectedSeries || !selectedVolume) {
    return (
      <div className="max-w-3xl mx-auto py-12 px-6">
        <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-8 text-center space-y-3">
          <Users className="w-8 h-8 mx-auto text-indigo-500" />
          <h2 className="text-lg font-bold text-slate-900 dark:text-zinc-100">
            Chọn Bộ truyện & Tập để quản lý Nhân vật & Xưng hô
          </h2>
          <p className="text-sm text-slate-500 dark:text-zinc-400">
            Hãy tạo bộ truyện và ít nhất 1 tập ở Quản lý Truyện trước khi chạy
            MAP/REDUCE và duyệt Continuity Pack.
          </p>
          <button
            type="button"
            onClick={onBackToDashboard}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
          >
            Đi tới Quản lý Truyện
          </button>
        </div>
      </div>
    )
  }

  const reviewCount = relationships.filter((r) => r.needs_review).length
  const missingReverseCount = relationships.filter(
    (r) => r.is_missing_reverse,
  ).length
  const lockedCount = relationships.filter((r) => r.is_locked).length

  return (
    <div className="max-w-[1600px] mx-auto p-5 space-y-4">
      {/* Header & Pipeline Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-xl font-bold tracking-tight text-slate-900 dark:text-zinc-100">
            Nhân vật & Xưng hô
          </h2>
          <span className="px-2.5 py-1 rounded-lg bg-slate-100 dark:bg-zinc-800 text-xs font-medium text-slate-600 dark:text-zinc-300">
            {formatVolumeLabel(selectedVolume)}
          </span>
          {statusInfo && (
            <span className="px-2.5 py-1 rounded-lg bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-300 text-xs font-semibold">
              MAP: {statusInfo.summarized_chapters}/{statusInfo.total_chapters}{' '}
              chương
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={runningMap || (statusInfo?.total_chapters ?? 0) === 0}
            onClick={() => void handleRunMap(false)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-900 hover:bg-slate-800 dark:bg-zinc-100 dark:hover:bg-zinc-200 dark:text-zinc-900 text-white disabled:opacity-45 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            {runningMap ? 'Đang chạy MAP PHASE...' : 'Chạy MAP PHASE'}
          </button>

          <button
            type="button"
            disabled={
              runningReduce || (statusInfo?.summarized_chapters ?? 0) === 0
            }
            onClick={() => void handleRunReduce()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-45 cursor-pointer"
          >
            <GitMerge className="w-3.5 h-3.5" />
            {runningReduce ? 'Đang REDUCE & MERGE...' : 'Chạy REDUCE & MERGE'}
          </button>

          <ActionMenu
            label="Tiện ích & XML"
            icon={<MoreHorizontal className="w-3.5 h-3.5" />}
            items={[
              {
                label: loading ? 'Đang làm mới...' : 'Làm mới dữ liệu',
                icon: (
                  <RefreshCw
                    className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`}
                  />
                ),
                onClick: () => void loadAll(),
              },
              {
                label: 'Chạy lại MAP toàn bộ (bỏ cache)',
                icon: <RotateCcw className="w-3.5 h-3.5 text-amber-500" />,
                disabled:
                  runningMap || (statusInfo?.total_chapters ?? 0) === 0,
                onClick: () => void handleRunMap(true),
              },
              {
                label: 'Sao chép Continuity XML',
                icon: <Copy className="w-3.5 h-3.5 text-indigo-500" />,
                disabled: !xmlContent,
                dividerBefore: true,
                onClick: () => void handleCopyXml(),
              },
              {
                label: `Tải vol${selectedVolume.volume_number}_continuity_pack.xml`,
                icon: <Download className="w-3.5 h-3.5 text-emerald-600" />,
                href: getContinuityXmlDownloadUrl(selectedVolume.id),
              },
            ]}
          />
        </div>
      </div>

      {/* Feedback */}
      {errorMsg && (
        <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 text-rose-700 dark:text-rose-300 text-sm">
          <span>{errorMsg}</span>
          <button
            type="button"
            onClick={() => setErrorMsg(null)}
            className="p-1 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {toastMsg && (
        <div className="px-4 py-3 rounded-xl border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 text-sm font-medium">
          {toastMsg}
        </div>
      )}

      {/* 3 Sub-Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-slate-200 dark:border-zinc-800 pb-3">
        <button
          type="button"
          onClick={() => setSubTab('roster')}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
            subTab === 'roster'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
          }`}
        >
          <Users className="w-4 h-4" />
          Nhân vật (Roster & Sub-Arc)
          <span
            className={`text-[11px] px-1.5 py-0.5 rounded-full ${
              subTab === 'roster'
                ? 'bg-white/20 text-white'
                : 'bg-slate-100 dark:bg-zinc-800 text-slate-500'
            }`}
          >
            {characters.length}
          </span>
        </button>

        <button
          type="button"
          onClick={() => setSubTab('review')}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
            subTab === 'review'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
          }`}
        >
          <MessageSquareQuote className="w-4 h-4" />
          Hàng đợi duyệt Xưng hô
          {reviewCount > 0 && (
            <span
              className={`text-[11px] font-bold px-1.5 py-0.5 rounded-full ${
                subTab === 'review'
                  ? 'bg-amber-400 text-slate-900'
                  : 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300'
              }`}
            >
              {reviewCount}
            </span>
          )}
        </button>

        <button
          type="button"
          onClick={() => setSubTab('xml')}
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors cursor-pointer ${
            subTab === 'xml'
              ? 'bg-indigo-600 text-white shadow-xs'
              : 'bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
          }`}
        >
          <Code2 className="w-4 h-4" />
          Xem trước / Tải XML
        </button>
      </div>

      {/* SUB-TAB 1: ROSTER & SUB-ARC */}
      {subTab === 'roster' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500 dark:text-zinc-400">
              Quản lý danh sách nhân vật toàn Series, trạng thái xuất hiện (
              <strong>ACTUAL / MENTIONED</strong>) và diễn biến{' '}
              <strong>Sub-Arc</strong> riêng cho{' '}
              <strong>{formatVolumeLabel(selectedVolume)}</strong>.
            </p>
            <button
              type="button"
              onClick={() => setCharModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Thêm nhân vật
            </button>
          </div>

          <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead className="bg-slate-50 dark:bg-zinc-950 text-slate-500 dark:text-zinc-400 uppercase text-[11px] border-b border-slate-200 dark:border-zinc-800">
                  <tr>
                    <th className="px-3 py-2.5 font-semibold">Tên gốc / Hiển thị</th>
                    <th className="px-2.5 py-2.5 font-semibold">Xuất hiện</th>
                    <th className="px-2.5 py-2.5 font-semibold">Biệt danh (Aliases)</th>
                    <th className="px-2.5 py-2.5 font-semibold">Archetype</th>
                    <th className="px-2.5 py-2.5 font-semibold">Xưng hô mặc định</th>
                    <th className="px-2.5 py-2.5 font-semibold">Sub-Arc / Trạng thái tập</th>
                    <th className="w-10 px-2 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-zinc-800">
                  {characters.length === 0 ? (
                    <tr>
                      <td
                        colSpan={7}
                        className="p-10 text-center text-sm text-slate-400"
                      >
                        Chưa có nhân vật nào. Hãy chạy MAP PHASE → REDUCE &
                        MERGE hoặc bấm "Thêm nhân vật".
                      </td>
                    </tr>
                  ) : (
                    characters.map((c) => (
                      <tr
                        key={c.id}
                        className="hover:bg-slate-50/70 dark:hover:bg-zinc-800/40 align-top"
                      >
                        <td className="px-3 py-2.5 min-w-[170px]">
                          <div className="font-semibold text-sm text-slate-900 dark:text-zinc-100">
                            {c.display_name}
                          </div>
                          <div className="text-[11px] text-slate-400">
                            {c.canonical_name}
                          </div>
                        </td>

                        <td className="px-2.5 py-2.5">
                          <select
                            value={c.appearance}
                            onChange={(e) =>
                              void handlePatchCharState(c.id, {
                                appearance: e.target
                                  .value as CharacterAppearance,
                              })
                            }
                            className={`px-2 py-1 rounded-full text-[11px] font-semibold border-0 cursor-pointer ${
                              c.appearance === 'ACTUAL'
                                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'
                                : 'bg-slate-100 text-slate-600 dark:bg-zinc-800 dark:text-zinc-400'
                            }`}
                          >
                            <option value="ACTUAL">ACTUAL</option>
                            <option value="MENTIONED">MENTIONED</option>
                          </select>
                        </td>

                        <td className="px-2.5 py-2.5 min-w-[180px]">
                          <EditableInlineText
                            value={c.aliases.join(' | ')}
                            placeholder="VD: ルディ | Quagmire"
                            onSave={(val) =>
                              void handlePatchCharacter(c.id, {
                                aliases: val
                                  .split(/[|,]/)
                                  .map((x) => x.trim())
                                  .filter(Boolean),
                              })
                            }
                          />
                        </td>

                        <td className="px-2.5 py-2.5">
                          <select
                            value={c.archetype}
                            onChange={(e) =>
                              void handlePatchCharacter(c.id, {
                                archetype: e.target.value,
                              })
                            }
                            className="px-2 py-1 rounded-lg border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950 text-xs"
                          >
                            {CHARACTER_ARCHETYPES.map((arch) => (
                              <option key={arch} value={arch}>
                                {arch}
                              </option>
                            ))}
                          </select>
                        </td>

                        <td className="px-2.5 py-2.5 min-w-[120px]">
                          <EditableInlineText
                            value={c.default_pair}
                            placeholder="Tôi-Cậu"
                            onSave={(val) =>
                              void handlePatchCharacter(c.id, {
                                default_pair: val,
                              })
                            }
                          />
                        </td>

                        <td className="px-2.5 py-2.5 min-w-[260px] space-y-1.5">
                          <div className="grid grid-cols-2 gap-1.5">
                            <EditableInlineText
                              value={c.subarc}
                              placeholder="Sub-arc (VD: TSUNDERE)"
                              onSave={(val) =>
                                void handlePatchCharState(c.id, { subarc: val })
                              }
                            />
                            <EditableInlineText
                              value={c.current_state}
                              placeholder="State (VD: DERE)"
                              onSave={(val) =>
                                void handlePatchCharState(c.id, {
                                  current_state: val,
                                })
                              }
                            />
                          </div>
                          <EditableInlineText
                            value={c.state_notes}
                            placeholder="Ghi chú chuyển biến tâm lý trong tập..."
                            onSave={(val) =>
                              void handlePatchCharState(c.id, { notes: val })
                            }
                          />
                        </td>

                        <td className="px-2 py-2.5 text-center">
                          <button
                            type="button"
                            title="Xóa nhân vật"
                            onClick={() => void handleDeleteCharacter(c)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: PRONOUN REVIEW QUEUE */}
      {subTab === 'review' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              {(
                [
                  { id: 'needs_review', label: `Chờ duyệt (${reviewCount})` },
                  {
                    id: 'missing_reverse',
                    label: `Thiếu chiều ngược (${missingReverseCount})`,
                  },
                  { id: 'locked', label: `Đã khóa (${lockedCount})` },
                  { id: 'all', label: `Tất cả (${relationships.length})` },
                ] as Array<{ id: ReviewFilter; label: string }>
              ).map((pill) => (
                <button
                  key={pill.id}
                  type="button"
                  onClick={() => setReviewFilter(pill.id)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-colors cursor-pointer ${
                    reviewFilter === pill.id
                      ? 'bg-indigo-600 text-white'
                      : 'bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 text-slate-600 dark:text-zinc-300 hover:bg-slate-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  {pill.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              disabled={characters.length < 2}
              onClick={() => {
                setNewRelForm({
                  source_char_id: characters[0]?.id ?? 0,
                  target_char_id: characters[1]?.id ?? 0,
                  pair_pronoun: 'Tôi-Cậu',
                  notes: '',
                  evidence_quote: '',
                  is_locked: false,
                })
                setRelModalOpen(true)
              }}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white disabled:opacity-45 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              Thêm cặp xưng hô
            </button>
          </div>

          {filteredRelationships.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-10 text-center text-sm text-slate-500 dark:text-zinc-400">
              {relationships.length === 0
                ? 'Chưa có cặp quan hệ nào. Hãy chạy MAP PHASE + REDUCE & MERGE hoặc tạo thủ công.'
                : 'Không có cặp quan hệ nào khớp bộ lọc hiện tại.'}
            </div>
          ) : (
            <div className="space-y-3">
              {filteredRelationships.map((rel) => {
                const currentPair = pairDrafts[rel.id] ?? rel.pair_pronoun
                const currentNotes = noteDrafts[rel.id] ?? rel.notes
                const isHighlight = rel.needs_review || rel.is_missing_reverse

                return (
                  <div
                    key={rel.id}
                    className={`rounded-2xl border p-4 transition-colors shadow-xs space-y-3 ${
                      rel.is_missing_reverse && rel.needs_review
                        ? 'border-rose-300 dark:border-rose-500/40 bg-rose-50/40 dark:bg-rose-500/5'
                        : isHighlight
                          ? 'border-amber-300 dark:border-amber-500/40 bg-amber-50/40 dark:bg-amber-500/5'
                          : 'border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900'
                    }`}
                  >
                    {/* Top row: directed pair + badges + lock/delete */}
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-bold text-sm text-slate-900 dark:text-zinc-100">
                          {rel.source_name}
                        </span>
                        <ArrowRight className="w-4 h-4 text-indigo-500" />
                        <span className="font-bold text-sm text-slate-900 dark:text-zinc-100">
                          {rel.target_name}
                        </span>

                        {rel.needs_review && (
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                            Chờ duyệt
                          </span>
                        )}

                        {rel.is_missing_reverse && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-100 text-rose-700 dark:bg-rose-500/20 dark:text-rose-300">
                            <AlertTriangle className="w-3 h-3" />
                            Thiếu chiều ngược
                          </span>
                        )}

                        {rel.is_locked && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
                            <Lock className="w-3 h-3" />
                            Đã khóa (cố định)
                          </span>
                        )}

                        <span className="text-[11px] text-slate-400">
                          Vol {rel.last_updated_vol} · RTAS{' '}
                          {rel.rtas_score.toFixed(1)}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleToggleLock(rel)}
                          className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                            rel.is_locked
                              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-300'
                              : 'border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-slate-700 dark:text-zinc-200 hover:bg-slate-50 dark:hover:bg-zinc-800'
                          }`}
                        >
                          {rel.is_locked ? (
                            <>
                              <Unlock className="w-3.5 h-3.5" /> Mở khóa
                            </>
                          ) : (
                            <>
                              <Lock className="w-3.5 h-3.5" /> Khóa (Lock)
                            </>
                          )}
                        </button>

                        <button
                          type="button"
                          title="Xóa cặp quan hệ"
                          onClick={() => void handleDeleteRel(rel)}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>

                    {/* Evidence quote */}
                    {rel.evidence_quote && (
                      <div className="rounded-xl bg-white/80 dark:bg-zinc-950/70 border border-slate-200 dark:border-zinc-800 px-3.5 py-2.5 text-xs">
                        <div className="text-[10px] uppercase tracking-wider font-semibold text-slate-400 mb-0.5">
                          Trích thoại gốc (Evidence Quote)
                        </div>
                        <p className="text-slate-700 dark:text-zinc-200 italic leading-relaxed">
                          “{rel.evidence_quote}”
                        </p>
                      </div>
                    )}

                    {/* Pronoun selector + Freehand input + Notes + Approve buttons */}
                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-2.5 items-center">
                      <div className="lg:col-span-3">
                        <select
                          aria-label="Chọn nhanh cặp xưng hô"
                          value={
                            (COMMON_PRONOUN_PAIRS as readonly string[]).includes(
                              currentPair,
                            )
                              ? currentPair
                              : ''
                          }
                          onChange={(e) => {
                            if (e.target.value) {
                              setPairDrafts((prev) => ({
                                ...prev,
                                [rel.id]: e.target.value,
                              }))
                            }
                          }}
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                        >
                          <option value="">-- Chọn nhanh cặp phổ biến --</option>
                          {COMMON_PRONOUN_PAIRS.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div className="lg:col-span-3">
                        <input
                          type="text"
                          value={currentPair}
                          onChange={(e) =>
                            setPairDrafts((prev) => ({
                              ...prev,
                              [rel.id]: e.target.value,
                            }))
                          }
                          placeholder="Hoặc gõ tay (VD: Em-Sư phụ)..."
                          className="w-full px-3 py-2 text-xs font-semibold rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                        />
                      </div>

                      <div className="lg:col-span-4">
                        <input
                          type="text"
                          value={currentNotes}
                          onChange={(e) =>
                            setNoteDrafts((prev) => ({
                              ...prev,
                              [rel.id]: e.target.value,
                            }))
                          }
                          placeholder="Ghi chú quan hệ / sắc thái..."
                          className="w-full px-3 py-2 text-xs rounded-xl border border-slate-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                        />
                      </div>

                      <div className="lg:col-span-2 flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleApproveRel(rel, false)}
                          className="inline-flex items-center gap-1 px-3 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                          Duyệt
                        </button>
                        <button
                          type="button"
                          title="Duyệt và Khóa cố định cho các tập sau"
                          onClick={() => void handleApproveRel(rel, true)}
                          className="inline-flex items-center gap-1 px-2.5 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white cursor-pointer"
                        >
                          <Lock className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* SUB-TAB 3: XML PREVIEW & DOWNLOAD */}
      {subTab === 'xml' && (
        <div className="space-y-4">
          {statusInfo && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  Tóm tắt tập (VOLUME_SUMMARY)
                </div>
                <p className="text-sm text-slate-700 dark:text-zinc-200 leading-relaxed whitespace-pre-wrap">
                  {statusInfo.volume_summary ||
                    'Chưa có tóm tắt tập. Hãy chạy MAP PHASE và REDUCE & MERGE.'}
                </p>
              </div>
              <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-5 space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  RTAS Analytics
                </div>
                <div className="flex items-baseline gap-4">
                  <div>
                    <div className="text-[11px] text-slate-400">Baseline</div>
                    <div className="text-xl font-bold text-slate-900 dark:text-zinc-100">
                      {statusInfo.rtas_baseline.toFixed(1)}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] text-slate-400">Current Avg</div>
                    <div className="text-xl font-bold text-indigo-600 dark:text-indigo-400">
                      {statusInfo.rtas_current_avg.toFixed(1)}
                    </div>
                  </div>
                </div>
                <p className="text-xs text-slate-600 dark:text-zinc-400 leading-relaxed">
                  {statusInfo.rtas_drift || 'Chưa có phân tích RTAS Drift.'}
                </p>
              </div>
            </div>
          )}

          <div className="rounded-2xl border border-slate-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden shadow-xs">
            <div className="px-5 py-3.5 border-b border-slate-200 dark:border-zinc-800 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-zinc-100 font-mono">
                  vol{selectedVolume.volume_number}_continuity_pack.xml
                </h3>
                <p className="text-xs text-slate-500 dark:text-zinc-400">
                  Render deterministic 100% từ SQLite — chỉ gồm thuật ngữ{' '}
                  <code>approved</code> có mặt trong tập.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handleCopyXml()}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-slate-200 dark:border-zinc-700 hover:bg-slate-50 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  <Copy className="w-3.5 h-3.5" />
                  Sao chép XML
                </button>
                <a
                  href={getContinuityXmlDownloadUrl(selectedVolume.id)}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white"
                >
                  <Download className="w-3.5 h-3.5" />
                  Tải XML
                </a>
              </div>
            </div>

            <pre className="p-5 text-xs font-mono text-slate-800 dark:text-zinc-200 bg-slate-50 dark:bg-zinc-950 overflow-x-auto max-h-[60vh] overflow-y-auto leading-relaxed">
              {xmlContent || '<!-- Chưa có dữ liệu XML -->'}
            </pre>
          </div>
        </div>
      )}

      {/* Add Character Modal */}
      {charModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                Thêm nhân vật vào Roster
              </h3>
              <button
                type="button"
                onClick={() => setCharModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleAddCharacter} className="p-6 space-y-3.5 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Tên gốc (JA/ZH/KO) *
                  </label>
                  <input
                    type="text"
                    required
                    value={newCharForm.canonical_name}
                    onChange={(e) =>
                      setNewCharForm({
                        ...newCharForm,
                        canonical_name: e.target.value,
                      })
                    }
                    placeholder="VD: ルーデウス・グレイラット"
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Tên hiển thị / Romaji *
                  </label>
                  <input
                    type="text"
                    required
                    value={newCharForm.display_name}
                    onChange={(e) =>
                      setNewCharForm({
                        ...newCharForm,
                        display_name: e.target.value,
                      })
                    }
                    placeholder="VD: Rudeus Greyrat"
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                  Biệt danh (phân tách bằng | hoặc dấu phẩy)
                </label>
                <input
                  type="text"
                  value={newCharForm.aliases}
                  onChange={(e) =>
                    setNewCharForm({ ...newCharForm, aliases: e.target.value })
                  }
                  placeholder="VD: ルディ | 泥沼のルーデウス"
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Archetype
                  </label>
                  <select
                    value={newCharForm.archetype}
                    onChange={(e) =>
                      setNewCharForm({
                        ...newCharForm,
                        archetype: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    {CHARACTER_ARCHETYPES.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Xưng hô mặc định
                  </label>
                  <input
                    type="text"
                    value={newCharForm.default_pair}
                    onChange={(e) =>
                      setNewCharForm({
                        ...newCharForm,
                        default_pair: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Xuất hiện tập này
                  </label>
                  <select
                    value={newCharForm.appearance}
                    onChange={(e) =>
                      setNewCharForm({
                        ...newCharForm,
                        appearance: e.target.value as CharacterAppearance,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    <option value="ACTUAL">ACTUAL</option>
                    <option value="MENTIONED">MENTIONED</option>
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setCharModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
                >
                  Lưu nhân vật
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Relationship Modal */}
      {relModalOpen && (
        <div className="fixed inset-0 z-50 bg-slate-950/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-zinc-900 border border-slate-200 dark:border-zinc-800 shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200 dark:border-zinc-800 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 dark:text-zinc-100">
                Thêm cặp xưng hô có hướng (A → B)
              </h3>
              <button
                type="button"
                onClick={() => setRelModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleAddRelationship} className="p-6 space-y-3.5 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Người nói (Source)
                  </label>
                  <select
                    value={newRelForm.source_char_id}
                    onChange={(e) =>
                      setNewRelForm({
                        ...newRelForm,
                        source_char_id: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    {characters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Người nghe (Target)
                  </label>
                  <select
                    value={newRelForm.target_char_id}
                    onChange={(e) =>
                      setNewRelForm({
                        ...newRelForm,
                        target_char_id: Number(e.target.value),
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    {characters.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Chọn nhanh
                  </label>
                  <select
                    value={
                      (COMMON_PRONOUN_PAIRS as readonly string[]).includes(
                        newRelForm.pair_pronoun,
                      )
                        ? newRelForm.pair_pronoun
                        : ''
                    }
                    onChange={(e) => {
                      if (e.target.value) {
                        setNewRelForm({
                          ...newRelForm,
                          pair_pronoun: e.target.value,
                        })
                      }
                    }}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  >
                    <option value="">-- Cặp phổ biến --</option>
                    {COMMON_PRONOUN_PAIRS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                    Cặp xưng hô (gõ tay) *
                  </label>
                  <input
                    type="text"
                    required
                    value={newRelForm.pair_pronoun}
                    onChange={(e) =>
                      setNewRelForm({
                        ...newRelForm,
                        pair_pronoun: e.target.value,
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 dark:text-zinc-400 mb-1">
                  Ghi chú quan hệ
                </label>
                <input
                  type="text"
                  value={newRelForm.notes}
                  onChange={(e) =>
                    setNewRelForm({ ...newRelForm, notes: e.target.value })
                  }
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-zinc-700 bg-slate-50 dark:bg-zinc-950"
                />
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-700 dark:text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newRelForm.is_locked}
                  onChange={(e) =>
                    setNewRelForm({
                      ...newRelForm,
                      is_locked: e.target.checked,
                    })
                  }
                  className="rounded border-slate-300 text-indigo-600"
                />
                <span>Khóa ngay (Lock) để giữ cố định ở tất cả các tập sau</span>
              </label>

              <div className="flex justify-end gap-2 pt-2 border-t border-slate-100 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={() => setRelModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-sm font-medium text-slate-600 dark:text-zinc-300 hover:bg-slate-100 dark:hover:bg-zinc-800 cursor-pointer"
                >
                  Hủy
                </button>
                <button
                  type="submit"
                  className="px-5 py-2 rounded-xl text-sm font-semibold bg-indigo-600 hover:bg-indigo-700 text-white cursor-pointer"
                >
                  Tạo cặp quan hệ
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}

function EditableInlineText({
  value,
  placeholder,
  onSave,
}: {
  value: string
  placeholder: string
  onSave: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  return (
    <input
      type="text"
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value) onSave(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
        else if (e.key === 'Escape') {
          setDraft(value)
          e.currentTarget.blur()
        }
      }}
      className="w-full px-2 py-1 rounded-md border border-transparent hover:border-slate-200 dark:hover:border-zinc-700 focus:border-indigo-500 bg-transparent focus:bg-white dark:focus:bg-zinc-950 text-xs focus:outline-none"
    />
  )
}
