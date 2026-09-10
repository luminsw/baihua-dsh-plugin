/**
 * medical.js — 百花家庭病历本客户端（经 Baihua.Family 管理 API /api/medical/*）。
 *
 * 医疗 API 是「非公开路径、仅允许 loopback 访问」的管理接口，无需额外 token，
 * 因此默认直连本机 http://127.0.0.1:8788；配置 medicalUrl 可覆盖（仅同机 loopback 有效）。
 */

function headersFor() {
  return { "Content-Type": "application/json" };
}

export function createMedicalClient(config) {
  // 支持传 config 对象或 getter（设置页表单改了即时生效）
  const cfg = () => (typeof config === "function" ? config() : config);
  const baseUrl = () => (cfg().medicalUrl || "http://127.0.0.1:8788").trim().replace(/\/+$/, "");

  async function call(path, { method = "GET", body } = {}, timeoutMs = 60000) {
    let res;
    try {
      res = await fetch(`${baseUrl()}${path}`, {
        method,
        headers: headersFor(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, error: "百花 Family 不可达（检查百花是否在线，或 medicalUrl 配置）" };
    }
    const text = await res.text().catch(() => "");
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    return { ok: res.ok, status: res.status, data };
  }

  function errorOf(r, fallback) {
    const d = r.data || {};
    let e = d.error ?? d.title ?? d.detail ?? "";
    if (typeof e !== "string" || !e) {
      const m = d.message;
      e = m && typeof m === "object" ? (m.value || m.name || "") : (typeof m === "string" ? m : "");
    }
    return `${fallback}（HTTP ${r.status}${e ? "：" + e : ""}）`;
  }

  /** GET /api/medical/members —— 全部家庭成员档案。 */
  async function listMembers() {
    const r = await call("/api/medical/members");
    if (!r.ok) return { ok: false, error: errorOf(r, "获取家庭成员失败") };
    return { ok: true, members: Array.isArray(r.data) ? r.data : [] };
  }

  /** POST /api/medical/members —— 创建成员档案。 */
  async function createMember({ name, gender = "", birthDate, bloodType = "", allergies = [], chronicDiseases = [], notes = "", heightCm, weightKg, occupation, lifeHabits, sportsInjuries = [], constitution }) {
    const r = await call("/api/medical/members", {
      method: "POST",
      body: {
        name,
        gender,
        birthDate: birthDate || undefined,
        bloodType,
        allergies: Array.isArray(allergies) ? allergies : [],
        chronicDiseases: Array.isArray(chronicDiseases) ? chronicDiseases : [],
        notes,
        heightCm: heightCm != null ? Number(heightCm) : undefined,
        weightKg: weightKg != null ? Number(weightKg) : undefined,
        occupation: occupation ? String(occupation) : undefined,
        lifeHabits: lifeHabits ? String(lifeHabits) : undefined,
        sportsInjuries: Array.isArray(sportsInjuries) ? sportsInjuries : [],
        constitution: constitution && typeof constitution === "object" ? constitution : undefined,
      },
    });
    if (!r.ok) return { ok: false, error: errorOf(r, "创建成员失败") };
    return { ok: true, member: r.data };
  }

  /** POST /api/medical/members/{memberId}/records —— 写入一条病历记录。 */
  async function saveRecord({ memberId, title, symptoms = [], diagnoses = [], medications = [], notes = "", fourDiagnostics }) {
    const r = await call(`/api/medical/members/${Number(memberId)}/records`, {
      method: "POST",
      body: {
        title,
        symptoms: Array.isArray(symptoms) ? symptoms : [],
        diagnoses: Array.isArray(diagnoses) ? diagnoses : [],
        medications: Array.isArray(medications) ? medications : [],
        notes,
        fourDiagnostics: fourDiagnostics && typeof fourDiagnostics === "object" ? fourDiagnostics : undefined,
      },
    });
    if (!r.ok) return { ok: false, error: errorOf(r, "保存病历失败") };
    return { ok: true, record: r.data };
  }

  /** GET /api/medical/members/{memberId} —— 成员详情（档案 + 病历记录 + AI 诊断历史）。 */
  async function getMember(memberId) {
    const r = await call(`/api/medical/members/${Number(memberId)}`);
    if (!r.ok) return { ok: false, error: errorOf(r, "获取成员失败") };
    return { ok: true, detail: r.data || {} };
  }

  /** GET /api/medical/records/search —— 按关键词检索病历记录。 */
  async function searchRecords(q, limit = 50) {
    const qs = `q=${encodeURIComponent(String(q ?? ""))}&limit=${Number(limit) || 50}`;
    const r = await call(`/api/medical/records/search?${qs}`);
    if (!r.ok) return { ok: false, error: errorOf(r, "检索病历失败") };
    return { ok: true, records: Array.isArray(r.data) ? r.data : [] };
  }

  return { listMembers, createMember, saveRecord, getMember, searchRecords, baseUrl: baseUrl() };
}
