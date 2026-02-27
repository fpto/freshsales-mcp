import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";

// ---------------------------------------------------------------------------
// URL / HTTP helpers
// ---------------------------------------------------------------------------

export const normalizeBaseUrl = (value = "") => {
  const trimmed = value.trim().replace(/\/$/, "");
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

export const ensureApiBasePath = (value = "") => {
  if (!value) return "";
  if (/\/crm\/sales\/api$/i.test(value) || /\/api$/i.test(value)) return value;
  return `${value}/crm/sales/api`;
};

export const createHttpClient = ({ apiKey, baseUrl }) =>
  axios.create({
    baseURL: baseUrl,
    headers: {
      Authorization: `Token token=${apiKey}`,
      "Content-Type": "application/json",
    },
  });

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODULE_TYPE_MAP = {
  contact: "Contact",
  contacts: "Contact",
  deal: "Deal",
  deals: "Deal",
  sales_account: "SalesAccount",
  account: "SalesAccount",
  accounts: "SalesAccount",
  task: "Task",
  tasks: "Task",
  meeting: "Appointment",
  appointment: "Appointment",
  appointments: "Appointment",
  sales_activity: "SalesActivity",
  sales_activities: "SalesActivity",
};

// Maps search_by / f parameter for lookup endpoint
const LOOKUP_FIELD_MAP = {
  email: "email",
  work_email: "email",
  mobile: "mobile_number",
  mobile_number: "mobile_number",
  phone: "phone",
  work_number: "phone",
  external_id: "external_id",
};

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

const isDefined = (v) => v !== undefined && v !== null;

const setNested = (target, parts, value) => {
  let cursor = target;
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i];
    if (i === parts.length - 1) {
      cursor[key] = value;
      return;
    }
    if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) {
      cursor[key] = {};
    }
    cursor = cursor[key];
  }
};

const buildPrefixedObject = (args, prefix) => {
  const payload = {};
  const token = `${prefix}__`;
  for (const [key, value] of Object.entries(args || {})) {
    if (!key.startsWith(token) || !isDefined(value)) continue;
    const parts = key.slice(token.length).split("__").filter(Boolean);
    if (!parts.length) continue;
    setNested(payload, parts, value);
  }
  return payload;
};

const parseId = (value) => {
  if (!isDefined(value)) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : null;
};

const normalizeSearchField = (v = "") => v.toString().trim().toLowerCase().replace(/\s+/g, "_");

const mapTargetableType = (moduleType = "") => {
  const normalized = moduleType.toString().trim().toLowerCase();
  return MODULE_TYPE_MAP[normalized] || moduleType;
};

const pick = (args, keys) => {
  const out = {};
  for (const key of keys) {
    if (isDefined(args[key])) out[key] = args[key];
  }
  return out;
};

const firstArrayItem = (v) => (Array.isArray(v) && v.length ? v[0] : null);

// ---------------------------------------------------------------------------
// HTML / Note sanitisation
// ---------------------------------------------------------------------------

const NOTE_TEXT_FIELDS = ["description", "description_text", "body", "note", "text"];

const isHtmlDocument = (v) =>
  typeof v === "string" && /<\s*!doctype\s+html|<\s*html[\s>]/i.test(v);

const stripHtml = (v = "") =>
  v
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

const cleanNoteText = (v) => {
  if (typeof v !== "string") return v;
  const trimmed = v.trim();
  if (!trimmed) return "";
  return stripHtml(trimmed);
};

const sanitizeNoteResponse = (raw) => {
  if (!isDefined(raw)) return raw;
  if (typeof raw === "string") {
    return isHtmlDocument(raw) ? { text: "", raw_html_filtered: true } : { text: cleanNoteText(raw) };
  }
  if (Array.isArray(raw)) return raw.map(sanitizeNoteResponse);
  if (typeof raw === "object") {
    const out = { ...raw };
    for (const f of NOTE_TEXT_FIELDS) {
      if (isDefined(out[f])) out[f] = cleanNoteText(out[f]);
    }
    if (NOTE_TEXT_FIELDS.some((f) => isHtmlDocument(raw[f]))) out.raw_html_filtered = true;
    return out;
  }
  return raw;
};

const sanitizeNotesInPayload = (value, keyHint = "") => {
  if (!isDefined(value)) return value;
  if (Array.isArray(value)) {
    return keyHint === "notes"
      ? value.map(sanitizeNoteResponse)
      : value.map((i) => sanitizeNotesInPayload(i, keyHint));
  }
  if (typeof value === "object") {
    if (keyHint === "note" || keyHint === "last_note") return sanitizeNoteResponse(value);
    const out = {};
    for (const [k, child] of Object.entries(value)) {
      const nk = k.toLowerCase();
      if (nk === "note" || nk === "last_note") out[k] = sanitizeNoteResponse(child);
      else if (nk === "notes")
        out[k] = Array.isArray(child) ? child.map(sanitizeNoteResponse) : sanitizeNoteResponse(child);
      else out[k] = sanitizeNotesInPayload(child, nk);
    }
    return out;
  }
  return value;
};

// ---------------------------------------------------------------------------
// Search / Lookup helpers
// ---------------------------------------------------------------------------

async function searchGeneral(http, q, include) {
  const res = await http.get("/search", { params: { q, include } });
  return res.data;
}

async function lookupByField(http, q, field, entities) {
  const res = await http.get("/lookup", { params: { q, f: field, entities } });
  return res.data;
}

function extractEntities(raw, preferredKey) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.results)) return raw.results;
  if (Array.isArray(raw[preferredKey])) return raw[preferredKey];
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.data)) return raw.data;
  return [];
}

// ---------------------------------------------------------------------------
// Entity resolution helpers
// ---------------------------------------------------------------------------

async function findContactInternal(http, searchBy, valueForFindBy) {
  const field = normalizeSearchField(searchBy);
  const id = parseId(valueForFindBy);
  const val = String(valueForFindBy).trim();

  // Direct ID lookup
  if (field === "contact_id" || field === "id") {
    if (!id) throw new Error("value_for_find_by must be numeric when search_by is contact_id");
    const res = await http.get(`/contacts/${id}`);
    const contact = res.data.contact ?? res.data;
    return { search_by: searchBy, value_for_find_by: valueForFindBy, matches: [contact], exact_match: contact };
  }

  // Try lookup endpoint first (more accurate for field-specific searches)
  const lookupField = LOOKUP_FIELD_MAP[field];
  if (lookupField) {
    try {
      const raw = await lookupByField(http, val, lookupField, "contact");
      const matches = extractEntities(raw, "contacts");
      if (matches.length) {
        const exact =
          matches.find((item) => {
            const email = item.email ?? item.work_email ?? firstArrayItem(item.emails)?.email;
            const mobile = item.mobile_number ?? item.phone_number;
            const phone = item.work_number ?? item.phone;
            const external = item.external_id;
            const lower = val.toLowerCase();
            if (lookupField === "email") return email?.toString().toLowerCase() === lower;
            if (lookupField === "mobile_number") return mobile?.toString() === val;
            if (lookupField === "phone") return phone?.toString() === val || mobile?.toString() === val;
            if (lookupField === "external_id") return external?.toString() === val;
            return false;
          }) ?? matches[0];
        return { search_by: searchBy, value_for_find_by: valueForFindBy, matches, exact_match: exact };
      }
    } catch (_) {
      // lookup endpoint may not be available; fall through to general search
    }
  }

  // Fallback: general search
  const raw = await searchGeneral(http, val, "contact");
  const matches = extractEntities(raw, "contacts");
  const exact =
    matches.find((item) => {
      const email = item.email ?? item.work_email ?? firstArrayItem(item.emails)?.email;
      const mobile = item.mobile_number ?? item.phone_number;
      const phone = item.work_number ?? item.phone;
      const external = item.external_id;
      const lower = val.toLowerCase();
      if (field.includes("email")) return email?.toString().toLowerCase() === lower;
      if (field.includes("phone") || field.includes("mobile")) return (mobile?.toString() === val || phone?.toString() === val);
      if (field.includes("external")) return external?.toString() === val;
      return false;
    }) ?? null;

  return { search_by: searchBy, value_for_find_by: valueForFindBy, matches, exact_match: exact, raw };
}

async function resolveContactId(http, updateBy, valueForUpdateBy) {
  const field = normalizeSearchField(updateBy);
  const directId = parseId(valueForUpdateBy);
  if (field === "contact_id" || field === "id") {
    if (!directId) throw new Error("value_for_update_by must be numeric when update_by is contact_id");
    return directId;
  }
  const found = await findContactInternal(http, updateBy, valueForUpdateBy);
  const candidate = found.exact_match ?? found.matches[0];
  const foundId = parseId(candidate?.id ?? candidate?.contact_id);
  if (!foundId) throw new Error("Could not resolve contact id from update_by / value_for_update_by");
  return foundId;
}

async function findAccountInternal(http, searchBy, valueForFindBy) {
  const field = normalizeSearchField(searchBy);
  const id = parseId(valueForFindBy);
  const val = String(valueForFindBy).trim();

  if (field === "account_id" || field === "id") {
    if (!id) throw new Error("value_for_find_by must be numeric when search_by is account_id");
    const res = await http.get(`/sales_accounts/${id}`);
    const account = res.data.sales_account ?? res.data;
    return { search_by: searchBy, value_for_find_by: valueForFindBy, matches: [account], exact_match: account };
  }

  // Try lookup first
  try {
    const raw = await lookupByField(http, val, "name", "sales_account");
    const matches = extractEntities(raw, "sales_accounts");
    if (matches.length) {
      const exact = matches.find((i) => (i.name ?? "").toLowerCase() === val.toLowerCase()) ?? matches[0];
      return { search_by: searchBy, value_for_find_by: valueForFindBy, matches, exact_match: exact };
    }
  } catch (_) { /* fall through */ }

  const raw = await searchGeneral(http, val, "sales_account");
  const matches = extractEntities(raw, "sales_accounts");
  const exact = matches.find((i) => (i.name ?? "").toLowerCase() === val.toLowerCase()) ?? null;
  return { search_by: searchBy, value_for_find_by: valueForFindBy, matches, exact_match: exact, raw };
}

async function resolveAccountId(http, updateBy, valueForUpdateBy) {
  const field = normalizeSearchField(updateBy);
  const directId = parseId(valueForUpdateBy);
  if (field === "account_id" || field === "id") {
    if (!directId) throw new Error("value_for_update_by must be numeric when update_by is account_id");
    return directId;
  }
  const found = await findAccountInternal(http, updateBy, valueForUpdateBy);
  const candidate = found.exact_match ?? found.matches[0];
  const foundId = parseId(candidate?.id ?? candidate?.sales_account_id);
  if (!foundId) throw new Error("Could not resolve account id");
  return foundId;
}

async function findDealInternal(http, findByNameOrId, valueForFindDeal) {
  const field = normalizeSearchField(findByNameOrId);
  const id = parseId(valueForFindDeal);
  const val = String(valueForFindDeal).trim();

  if (field === "deal_id" || field === "id") {
    if (!id) throw new Error("value_for_find_deal must be numeric when find_by_name_or_id is deal_id");
    const res = await http.get(`/deals/${id}`);
    const deal = res.data.deal ?? res.data;
    return { find_by_name_or_id: findByNameOrId, value_for_find_deal: valueForFindDeal, matches: [deal], exact_match: deal };
  }

  const raw = await searchGeneral(http, val, "deal");
  const matches = extractEntities(raw, "deals");
  const exact = matches.find((i) => (i.name ?? "").toLowerCase() === val.toLowerCase()) ?? null;
  return { find_by_name_or_id: findByNameOrId, value_for_find_deal: valueForFindDeal, matches, exact_match: exact, raw };
}

// ---------------------------------------------------------------------------
// Schema helper
// ---------------------------------------------------------------------------

function createSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: true };
}

const STR = { type: "string" };
const NUM_STR = { type: ["number", "string"] };
const BOOL_STR = { type: ["boolean", "string"] };
const STR_ARR = { type: "array", items: { type: "string" } };
const NUM_ARR = { type: "array", items: { type: ["number", "string"] } };

// ---------------------------------------------------------------------------
// Shared field groups for schemas
// ---------------------------------------------------------------------------

const CONTACT_FIELDS = {
  contact__first_name: STR,
  contact__last_name: STR,
  contact__email: STR,
  contact__work_email: STR,
  contact__emails: { type: "array", items: { type: ["string", "object"] } },
  contact__mobile_number: STR,
  contact__work_number: STR,
  contact__phone_numbers: STR_ARR,
  contact__job_title: STR,
  contact__address: STR,
  contact__city: STR,
  contact__state: STR,
  contact__country: STR,
  contact__zipcode: STR,
  contact__time_zone: STR,
  contact__external_id: STR,
  contact__facebook: STR,
  contact__twitter: STR,
  contact__linkedin: STR,
  contact__medium: STR,
  contact__keyword: STR,
  contact__lead_score: NUM_STR,
  contact__lead_source_id: NUM_STR,
  contact__owner_id: NUM_STR,
  contact__territory_id: NUM_STR,
  contact__campaign_id: NUM_STR,
  contact__contact_status_id: NUM_STR,
  contact__lifecycle_stage_id: NUM_STR,
  contact__subscription_status: STR,
  contact__subscription_types: STR_ARR,
  contact__tags: STR_ARR,
  contact__sales_accounts: { type: "array", items: { type: "object" } },
  contact__sales_account__name: STR,
  contact__custom_field: { type: "object" },
};

const ACCOUNT_FIELDS = {
  sales_account__name: STR,
  sales_account__website: STR,
  sales_account__phone: STR,
  sales_account__address: STR,
  sales_account__city: STR,
  sales_account__state: STR,
  sales_account__country: STR,
  sales_account__zipcode: STR,
  sales_account__industry_type_id: NUM_STR,
  sales_account__business_type_id: NUM_STR,
  sales_account__number_of_employees: NUM_STR,
  sales_account__annual_revenue: NUM_STR,
  sales_account__owner_id: NUM_STR,
  sales_account__territory_id: NUM_STR,
  sales_account__parent_sales_account_id: NUM_STR,
  sales_account__tags: STR_ARR,
  sales_account__facebook: STR,
  sales_account__twitter: STR,
  sales_account__linkedin: STR,
  sales_account__custom_field: { type: "object" },
};

const DEAL_FIELDS = {
  deal__name: STR,
  deal__amount: NUM_STR,
  deal__currency_id: NUM_STR,
  deal__deal_pipeline_id: NUM_STR,
  deal__deal_stage_id: NUM_STR,
  deal__deal_type_id: NUM_STR,
  deal__expected_close: STR,
  deal__closed_date: STR,
  deal__owner_id: NUM_STR,
  deal__sales_account_id: NUM_STR,
  deal__sales_account__name: STR,
  deal__contacts_added_list: { type: "array", items: { type: ["string", "number"] } },
  deal__probability: NUM_STR,
  deal__lead_source_id: NUM_STR,
  deal__campaign_id: NUM_STR,
  deal__deal_product_id: NUM_STR,
  deal__territory_id: NUM_STR,
  deal__tags: STR_ARR,
  deal__deal_payment_status_id: NUM_STR,
  deal__deal_reason_id: NUM_STR,
  deal__forecast_category: STR,
  deal__custom_field: { type: "object" },
};

// ---------------------------------------------------------------------------
// TOOL DEFINITIONS
// ---------------------------------------------------------------------------

export function getTools() {
  return [
    // ── Contacts ──────────────────────────────────────────────────────────
    {
      name: "freshsales_suite_create_contact",
      description: "Crea un nuevo contacto en Freshsales Suite.",
      inputSchema: createSchema(CONTACT_FIELDS),
    },
    {
      name: "freshsales_suite_update_contact",
      description: "Actualiza un contacto existente en Freshsales Suite.",
      inputSchema: createSchema(
        {
          update_by: { ...STR, description: "Campo para buscar: contact_id, email, phone, mobile, external_id" },
          value_for_update_by: { ...NUM_STR, description: "Valor del campo de busqueda" },
          list_operation: STR,
          list_name: STR,
          lifecycle_stage: { type: ["string", "object"] },
          ...CONTACT_FIELDS,
        },
        ["update_by", "value_for_update_by"],
      ),
    },
    {
      name: "freshsales_suite_find_contact_by_unique_fields",
      description:
        "Busca un contacto por campos unicos (ID, email, telefono, external_id). Usa el endpoint /lookup para busquedas exactas por campo.",
      inputSchema: createSchema(
        {
          search_by: { ...STR, description: "Campo de busqueda: contact_id, email, phone, mobile, external_id" },
          value_for_find_by: NUM_STR,
        },
        ["search_by", "value_for_find_by"],
      ),
    },
    {
      name: "freshsales_suite_delete_contact",
      description: "Elimina un contacto por ID.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },
    {
      name: "freshsales_suite_list_contacts",
      description:
        "Lista contactos de una vista. Requiere view_id (obtener con freshsales_suite_list_contact_filters).",
      inputSchema: createSchema({
        view_id: { ...NUM_STR, description: "ID de la vista/filtro" },
        page: { ...NUM_STR, description: "Pagina (por defecto 1, 25 items por pagina)" },
        sort: { ...STR, description: "Campo de ordenamiento: lead_score, created_at, updated_at, open_deals_amount, last_contacted" },
        sort_type: { ...STR, description: "asc o desc" },
      }, ["view_id"]),
    },
    {
      name: "freshsales_suite_list_contact_filters",
      description: "Lista las vistas/filtros disponibles para contactos.",
      inputSchema: createSchema({}),
    },
    {
      name: "freshsales_suite_list_contact_fields",
      description: "Lista todos los campos disponibles para contactos, incluyendo campos personalizados.",
      inputSchema: createSchema({
        include: { ...STR, description: "Incluir grupo de campos: field_group" },
      }),
    },
    {
      name: "freshsales_suite_upsert_contact",
      description:
        "Crea o actualiza un contacto. Si el identificador unico coincide, actualiza; si no, crea uno nuevo.",
      inputSchema: createSchema(
        {
          unique_identifier: {
            type: "object",
            description: "Identificador unico, ej: { emails: 'email@test.com' } o { id: 123 }",
          },
          ...CONTACT_FIELDS,
        },
        ["unique_identifier"],
      ),
    },
    {
      name: "freshsales_suite_list_contact_activities",
      description: "Lista las actividades de un contacto.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },

    // ── Accounts ──────────────────────────────────────────────────────────
    {
      name: "freshsales_suite_create_account",
      description: "Crea una nueva cuenta (empresa/organizacion).",
      inputSchema: createSchema(ACCOUNT_FIELDS),
    },
    {
      name: "freshsales_suite_update_account",
      description: "Actualiza una cuenta existente.",
      inputSchema: createSchema(
        {
          update_by: { ...STR, description: "Campo: account_id, id, name" },
          value_for_update_by: NUM_STR,
          ...ACCOUNT_FIELDS,
        },
        ["update_by", "value_for_update_by"],
      ),
    },
    {
      name: "freshsales_suite_find_account",
      description: "Busca una cuenta existente por ID o nombre.",
      inputSchema: createSchema(
        { search_by: STR, value_for_find_by: NUM_STR },
        ["search_by", "value_for_find_by"],
      ),
    },
    {
      name: "freshsales_suite_delete_account",
      description: "Elimina una cuenta por ID.",
      inputSchema: createSchema(
        { id: NUM_STR, delete_associated_contacts_deals: BOOL_STR },
        ["id"],
      ),
    },
    {
      name: "freshsales_suite_list_accounts",
      description: "Lista cuentas de una vista.",
      inputSchema: createSchema({
        view_id: NUM_STR,
        page: NUM_STR,
        sort: { ...STR, description: "open_deals_amount, created_at, updated_at, last_contacted" },
        sort_type: STR,
      }, ["view_id"]),
    },
    {
      name: "freshsales_suite_list_account_filters",
      description: "Lista las vistas/filtros disponibles para cuentas.",
      inputSchema: createSchema({}),
    },
    {
      name: "freshsales_suite_list_account_fields",
      description: "Lista todos los campos disponibles para cuentas.",
      inputSchema: createSchema({ include: STR }),
    },
    {
      name: "freshsales_suite_upsert_account",
      description: "Crea o actualiza una cuenta (upsert).",
      inputSchema: createSchema(
        { unique_identifier: { type: "object" }, ...ACCOUNT_FIELDS },
        ["unique_identifier"],
      ),
    },

    // ── Deals ─────────────────────────────────────────────────────────────
    {
      name: "freshsales_suite_create_deal",
      description: "Crea una nueva oportunidad de venta (deal).",
      inputSchema: createSchema(DEAL_FIELDS),
    },
    {
      name: "freshsales_suite_update_deal",
      description: "Actualiza un deal existente.",
      inputSchema: createSchema(
        { value_for_update_by: { ...NUM_STR, description: "Deal ID" }, ...DEAL_FIELDS },
        ["value_for_update_by"],
      ),
    },
    {
      name: "freshsales_suite_find_deal",
      description: "Busca un deal por ID o nombre.",
      inputSchema: createSchema(
        { find_by_name_or_id: STR, value_for_find_deal: NUM_STR },
        ["find_by_name_or_id", "value_for_find_deal"],
      ),
    },
    {
      name: "freshsales_suite_delete_deal",
      description: "Elimina un deal por ID.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },
    {
      name: "freshsales_suite_list_deals",
      description: "Lista deals de una vista.",
      inputSchema: createSchema({
        view_id: NUM_STR,
        page: NUM_STR,
        sort: STR,
        sort_type: STR,
      }, ["view_id"]),
    },
    {
      name: "freshsales_suite_list_deal_filters",
      description: "Lista las vistas/filtros disponibles para deals.",
      inputSchema: createSchema({}),
    },
    {
      name: "freshsales_suite_list_deal_fields",
      description: "Lista todos los campos disponibles para deals.",
      inputSchema: createSchema({}),
    },
    {
      name: "freshsales_suite_upsert_deal",
      description: "Crea o actualiza un deal (upsert).",
      inputSchema: createSchema(
        { unique_identifier: { type: "object" }, ...DEAL_FIELDS },
        ["unique_identifier"],
      ),
    },

    // ── Tasks ─────────────────────────────────────────────────────────────
    {
      name: "freshsales_suite_create_task",
      description: "Crea una tarea en Freshsales Suite.",
      inputSchema: createSchema({
        title: STR,
        description: STR,
        due_date: STR,
        owner_id: NUM_STR,
        status: { ...NUM_STR, description: "0 = Open, 1 = Completed" },
        task_type_id: NUM_STR,
        outcome_id: NUM_STR,
        targetable_type: { ...STR, description: "Contact, Deal, SalesAccount" },
        targetable_id: NUM_STR,
        collaborators: NUM_ARR,
      }),
    },
    {
      name: "freshsales_suite_update_task",
      description: "Actualiza una tarea existente.",
      inputSchema: createSchema(
        {
          id: NUM_STR,
          title: STR,
          description: STR,
          due_date: STR,
          owner_id: NUM_STR,
          status: NUM_STR,
          task_type_id: NUM_STR,
          outcome_id: NUM_STR,
          targetable_type: STR,
          targetable_id: NUM_STR,
        },
        ["id"],
      ),
    },
    {
      name: "freshsales_suite_find_task",
      description: "Obtiene los detalles de una tarea por ID.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },
    {
      name: "freshsales_suite_list_tasks",
      description: "Lista tareas con filtro opcional.",
      inputSchema: createSchema({
        filter: { ...STR, description: "Filtro: open, due_today, due_tomorrow, overdue, completed" },
        page: NUM_STR,
        include: { ...STR, description: "Relaciones a incluir, ej: owner,users,targetable" },
      }),
    },
    {
      name: "freshsales_suite_delete_task",
      description: "Elimina una tarea por ID.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },
    {
      name: "freshsales_suite_mark_task_done",
      description: "Marca una tarea como completada.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },

    // ── Appointments ──────────────────────────────────────────────────────
    {
      name: "freshsales_suite_create_meeting",
      description: "Crea una reunion/cita (appointment).",
      inputSchema: createSchema({
        title: STR,
        description: STR,
        from_date: { ...STR, description: "Fecha/hora inicio (ISO 8601)" },
        end_date: { ...STR, description: "Fecha/hora fin (ISO 8601)" },
        time_zone: STR,
        location: STR,
        targetable_type: { ...STR, description: "Contact, Deal, SalesAccount" },
        targetable_id: NUM_STR,
        attendees: { type: "array", items: { type: "object" }, description: "Lista de asistentes" },
      }),
    },
    {
      name: "freshsales_suite_update_meeting",
      description: "Actualiza una reunion existente.",
      inputSchema: createSchema(
        {
          id: NUM_STR,
          title: STR,
          description: STR,
          from_date: STR,
          end_date: STR,
          time_zone: STR,
          location: STR,
          targetable_type: STR,
          targetable_id: NUM_STR,
          attendees: { type: "array", items: { type: "object" } },
        },
        ["id"],
      ),
    },
    {
      name: "freshsales_suite_find_meeting",
      description: "Obtiene los detalles de una reunion por ID.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },
    {
      name: "freshsales_suite_list_meetings",
      description: "Lista reuniones con filtro opcional.",
      inputSchema: createSchema({
        filter: { ...STR, description: "Filtro: upcoming, past" },
        page: NUM_STR,
        include: STR,
      }),
    },
    {
      name: "freshsales_suite_delete_meeting",
      description: "Elimina una reunion por ID.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },

    // ── Sales Activities ──────────────────────────────────────────────────
    {
      name: "freshsales_suite_create_custom_sales_activity",
      description: "Crea una actividad de venta.",
      inputSchema: createSchema({
        title: STR,
        notes: STR,
        start_date: STR,
        end_date: STR,
        sales_activity_type_id: NUM_STR,
        sales_activity_outcome_id: NUM_STR,
        owner_id: NUM_STR,
        targetable_type: { ...STR, description: "Contact, Deal, SalesAccount" },
        targetable_id: NUM_STR,
        duration: NUM_STR,
        location: STR,
        collaborators: NUM_ARR,
      }),
    },
    {
      name: "freshsales_suite_update_sales_activity",
      description: "Actualiza una actividad de venta existente.",
      inputSchema: createSchema(
        {
          id: NUM_STR,
          title: STR,
          notes: STR,
          start_date: STR,
          end_date: STR,
          sales_activity_type_id: NUM_STR,
          sales_activity_outcome_id: NUM_STR,
          owner_id: NUM_STR,
          targetable_type: STR,
          targetable_id: NUM_STR,
          duration: NUM_STR,
          location: STR,
        },
        ["id"],
      ),
    },
    {
      name: "freshsales_suite_find_sales_activity",
      description: "Obtiene los detalles de una actividad de venta por ID.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },
    {
      name: "freshsales_suite_list_sales_activities",
      description: "Lista actividades de venta.",
      inputSchema: createSchema({ page: NUM_STR, include: STR }),
    },
    {
      name: "freshsales_suite_delete_sales_activity",
      description: "Elimina una actividad de venta por ID.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },

    // ── Notes ─────────────────────────────────────────────────────────────
    {
      name: "freshsales_suite_add_note_to_contact",
      description: "Agrega una nota a un contacto.",
      inputSchema: createSchema(
        {
          note__description: STR,
          update_by: { ...STR, description: "contact_id, email, phone, external_id" },
          value_for_update_by: NUM_STR,
        },
        ["note__description", "update_by", "value_for_update_by"],
      ),
    },
    {
      name: "freshsales_suite_add_note",
      description: "Crea una nota en un modulo seleccionado (Contact, Deal, SalesAccount).",
      inputSchema: createSchema(
        {
          note_input: { ...STR, description: "Contenido de la nota" },
          module_type: { ...STR, description: "contact, deal, sales_account" },
          targetable_id: NUM_STR,
        },
        ["note_input", "module_type", "targetable_id"],
      ),
    },
    {
      name: "freshsales_suite_update_note",
      description: "Actualiza una nota existente.",
      inputSchema: createSchema(
        { id: NUM_STR, description: { ...STR, description: "Nuevo contenido de la nota" } },
        ["id", "description"],
      ),
    },
    {
      name: "freshsales_suite_delete_note",
      description: "Elimina una nota por ID.",
      inputSchema: createSchema({ id: NUM_STR }, ["id"]),
    },

    // ── Files ─────────────────────────────────────────────────────────────
    {
      name: "freshsales_suite_add_file",
      description: "Sube un archivo y lo asocia a un registro.",
      inputSchema: createSchema(
        {
          file_name: STR,
          file_path: STR,
          select_one_module: { ...STR, description: "contact, deal, sales_account" },
          unique_identifier: NUM_STR,
          share_with_team: BOOL_STR,
        },
        ["file_name", "file_path", "select_one_module", "unique_identifier"],
      ),
    },

    // ── Marketing Events ──────────────────────────────────────────────────
    {
      name: "freshsales_suite_create_a_marketing_event",
      description: "Crea un evento de marketing (solo Freshsales Suite y Freshmarketer).",
      inputSchema: createSchema({
        event_name: STR,
        unique_identifer_name: STR,
        unique_identifier: NUM_STR,
        additional_event_properties: { type: ["object", "array", "string"] },
      }),
    },

    // ── Custom Modules ────────────────────────────────────────────────────
    {
      name: "freshsales_suite_create_a_record_on_custom_module",
      description: "Crea un registro en un modulo personalizado.",
      inputSchema: createSchema({ module_name: STR, fields: { type: "object" } }, ["module_name"]),
    },

    // ── Users ─────────────────────────────────────────────────────────────
    {
      name: "freshsales_suite_find_user",
      description: "Busca un usuario existente por correo electronico.",
      inputSchema: createSchema({ email_id_of_the_user: STR }, ["email_id_of_the_user"]),
    },

    // ── Search & Lookup ───────────────────────────────────────────────────
    {
      name: "freshsales_suite_search",
      description:
        "Busqueda general en Freshsales. Busca a traves de contactos, cuentas, deals y otros modulos.",
      inputSchema: createSchema(
        {
          q: { ...STR, description: "Termino de busqueda" },
          include: { ...STR, description: "Entidades a incluir separadas por coma: contact, sales_account, deal, user" },
        },
        ["q"],
      ),
    },
    {
      name: "freshsales_suite_lookup",
      description:
        "Busqueda especifica por campo. Mas preciso que search. Util para buscar contactos por email, telefono, etc.",
      inputSchema: createSchema(
        {
          q: { ...STR, description: "Valor a buscar" },
          f: { ...STR, description: "Campo: email, mobile_number, phone, name, external_id, etc." },
          entities: { ...STR, description: "Tipo de entidad: contact, sales_account, deal" },
        },
        ["q", "f", "entities"],
      ),
    },

    // ── Selectors / Configuration ─────────────────────────────────────────
    {
      name: "freshsales_suite_get_selector",
      description:
        "Obtiene datos de configuracion: owners, territories, deal_stages, currencies, deal_reasons, " +
        "deal_types, lead_sources, industry_types, business_types, campaigns, deal_payment_statuses, " +
        "deal_products, deal_pipelines, contact_statuses, sales_activity_types, sales_activity_outcomes, " +
        "lifecycle_stages, designations.",
      inputSchema: createSchema(
        {
          selector_type: {
            ...STR,
            description:
              "Tipo: owners, territories, deal_stages, currencies, deal_reasons, deal_types, " +
              "lead_sources, industry_types, business_types, campaigns, deal_payment_statuses, " +
              "deal_products, deal_pipelines, contact_statuses, sales_activity_types, " +
              "sales_activity_outcomes, lifecycle_stages, designations",
          },
          parent_id: { ...NUM_STR, description: "ID padre (ej: pipeline_id para obtener sus deal_stages)" },
        },
        ["selector_type"],
      ),
    },

    // ── Marketing Lists ───────────────────────────────────────────────────
    {
      name: "freshsales_suite_create_list",
      description: "Crea una nueva lista de marketing.",
      inputSchema: createSchema({ name: STR }, ["name"]),
    },
    {
      name: "freshsales_suite_list_lists",
      description: "Obtiene todas las listas de marketing.",
      inputSchema: createSchema({}),
    },
    {
      name: "freshsales_suite_add_contacts_to_list",
      description: "Agrega contactos a una lista de marketing.",
      inputSchema: createSchema(
        { list_id: NUM_STR, ids: { type: "array", items: NUM_STR, description: "IDs de contactos" } },
        ["list_id", "ids"],
      ),
    },
    {
      name: "freshsales_suite_remove_contacts_from_list",
      description: "Remueve contactos de una lista de marketing.",
      inputSchema: createSchema(
        { list_id: NUM_STR, ids: { type: "array", items: NUM_STR, description: "IDs de contactos (vacio = todos)" } },
        ["list_id"],
      ),
    },

    // ── Phone Calls ───────────────────────────────────────────────────────
    {
      name: "freshsales_suite_log_phone_call",
      description: "Registra una llamada telefonica manualmente.",
      inputSchema: createSchema({
        contact_id: NUM_STR,
        deal_id: NUM_STR,
        note: STR,
        duration: NUM_STR,
        call_direction: { ...STR, description: "Outgoing o Incoming" },
        call_type: { ...STR, description: "Tipo de llamada" },
      }),
    },
  ];
}

// ---------------------------------------------------------------------------
// TOOL IMPLEMENTATIONS
// ---------------------------------------------------------------------------

export async function runTool(http, name, args = {}) {
  switch (name) {
    // ── Contacts ────────────────────────────────────────────────────────

    case "freshsales_suite_create_contact": {
      const contact = buildPrefixedObject(args, "contact");
      const res = await http.post("/contacts", { contact });
      return sanitizeNotesInPayload({ success: true, contact: res.data.contact ?? res.data });
    }

    case "freshsales_suite_update_contact": {
      const id = await resolveContactId(http, args.update_by, args.value_for_update_by);
      const contact = buildPrefixedObject(args, "contact");
      const ctrl = pick(args, ["list_operation", "list_name", "lifecycle_stage"]);
      const payload = Object.keys(ctrl).length ? { ...contact, ...ctrl } : contact;
      const res = await http.put(`/contacts/${id}`, { contact: payload });
      return sanitizeNotesInPayload({ success: true, id, contact: res.data.contact ?? res.data });
    }

    case "freshsales_suite_find_contact_by_unique_fields": {
      const result = await findContactInternal(http, args.search_by, args.value_for_find_by);
      return sanitizeNotesInPayload({ success: true, ...result });
    }

    case "freshsales_suite_delete_contact": {
      const id = parseId(args.id);
      if (!id) throw new Error("id must be a valid numeric ID");
      await http.delete(`/contacts/${id}`);
      return { success: true, id, deleted: true };
    }

    case "freshsales_suite_list_contacts": {
      const viewId = parseId(args.view_id);
      if (!viewId) throw new Error("view_id is required");
      const params = {};
      if (args.page) params.page = args.page;
      if (args.sort) params.sort = args.sort;
      if (args.sort_type) params.sort_type = args.sort_type;
      const res = await http.get(`/contacts/view/${viewId}`, { params });
      return sanitizeNotesInPayload({ success: true, ...res.data });
    }

    case "freshsales_suite_list_contact_filters": {
      const res = await http.get("/contacts/filters");
      return { success: true, filters: res.data.filters ?? res.data };
    }

    case "freshsales_suite_list_contact_fields": {
      const params = {};
      if (args.include) params.include = args.include;
      const res = await http.get("/settings/contacts/fields", { params });
      return { success: true, fields: res.data.fields ?? res.data };
    }

    case "freshsales_suite_upsert_contact": {
      const contact = buildPrefixedObject(args, "contact");
      const res = await http.post("/contacts/upsert", {
        unique_identifier: args.unique_identifier,
        contact,
      });
      return sanitizeNotesInPayload({ success: true, contact: res.data.contact ?? res.data });
    }

    case "freshsales_suite_list_contact_activities": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      const res = await http.get(`/contacts/${id}/activities.json`, { params: { include: "user" } });
      return sanitizeNotesInPayload({ success: true, activities: res.data.activities ?? res.data });
    }

    // ── Accounts ────────────────────────────────────────────────────────

    case "freshsales_suite_create_account": {
      const sales_account = buildPrefixedObject(args, "sales_account");
      const res = await http.post("/sales_accounts", { sales_account });
      return sanitizeNotesInPayload({ success: true, sales_account: res.data.sales_account ?? res.data });
    }

    case "freshsales_suite_update_account": {
      const id = await resolveAccountId(http, args.update_by, args.value_for_update_by);
      const sales_account = buildPrefixedObject(args, "sales_account");
      const res = await http.put(`/sales_accounts/${id}`, { sales_account });
      return sanitizeNotesInPayload({ success: true, id, sales_account: res.data.sales_account ?? res.data });
    }

    case "freshsales_suite_find_account": {
      const result = await findAccountInternal(http, args.search_by, args.value_for_find_by);
      return sanitizeNotesInPayload({ success: true, ...result });
    }

    case "freshsales_suite_delete_account": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      const params = {};
      if (args.delete_associated_contacts_deals) params.delete_associated_contacts_deals = true;
      await http.delete(`/sales_accounts/${id}`, { params });
      return { success: true, id, deleted: true };
    }

    case "freshsales_suite_list_accounts": {
      const viewId = parseId(args.view_id);
      if (!viewId) throw new Error("view_id is required");
      const params = {};
      if (args.page) params.page = args.page;
      if (args.sort) params.sort = args.sort;
      if (args.sort_type) params.sort_type = args.sort_type;
      const res = await http.get(`/sales_accounts/view/${viewId}`, { params });
      return sanitizeNotesInPayload({ success: true, ...res.data });
    }

    case "freshsales_suite_list_account_filters": {
      const res = await http.get("/sales_accounts/filters");
      return { success: true, filters: res.data.filters ?? res.data };
    }

    case "freshsales_suite_list_account_fields": {
      const params = {};
      if (args.include) params.include = args.include;
      const res = await http.get("/settings/sales_accounts/fields", { params });
      return { success: true, fields: res.data.fields ?? res.data };
    }

    case "freshsales_suite_upsert_account": {
      const sales_account = buildPrefixedObject(args, "sales_account");
      const res = await http.post("/sales_accounts/upsert", {
        unique_identifier: args.unique_identifier,
        sales_account,
      });
      return sanitizeNotesInPayload({ success: true, sales_account: res.data.sales_account ?? res.data });
    }

    // ── Deals ───────────────────────────────────────────────────────────

    case "freshsales_suite_create_deal": {
      const deal = buildPrefixedObject(args, "deal");
      const res = await http.post("/deals", { deal });
      return sanitizeNotesInPayload({ success: true, deal: res.data.deal ?? res.data });
    }

    case "freshsales_suite_update_deal": {
      const id = parseId(args.value_for_update_by);
      if (!id) throw new Error("value_for_update_by must be a valid Deal ID");
      const deal = buildPrefixedObject(args, "deal");
      const res = await http.put(`/deals/${id}`, { deal });
      return sanitizeNotesInPayload({ success: true, id, deal: res.data.deal ?? res.data });
    }

    case "freshsales_suite_find_deal": {
      const result = await findDealInternal(http, args.find_by_name_or_id, args.value_for_find_deal);
      return sanitizeNotesInPayload({ success: true, ...result });
    }

    case "freshsales_suite_delete_deal": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      await http.delete(`/deals/${id}`);
      return { success: true, id, deleted: true };
    }

    case "freshsales_suite_list_deals": {
      const viewId = parseId(args.view_id);
      if (!viewId) throw new Error("view_id is required");
      const params = {};
      if (args.page) params.page = args.page;
      if (args.sort) params.sort = args.sort;
      if (args.sort_type) params.sort_type = args.sort_type;
      const res = await http.get(`/deals/view/${viewId}`, { params });
      return sanitizeNotesInPayload({ success: true, ...res.data });
    }

    case "freshsales_suite_list_deal_filters": {
      const res = await http.get("/deals/filters");
      return { success: true, filters: res.data.filters ?? res.data };
    }

    case "freshsales_suite_list_deal_fields": {
      const res = await http.get("/settings/deals/fields");
      return { success: true, fields: res.data.fields ?? res.data };
    }

    case "freshsales_suite_upsert_deal": {
      const deal = buildPrefixedObject(args, "deal");
      const res = await http.post("/deals/upsert", {
        unique_identifier: args.unique_identifier,
        deal,
      });
      return sanitizeNotesInPayload({ success: true, deal: res.data.deal ?? res.data });
    }

    // ── Tasks ───────────────────────────────────────────────────────────

    case "freshsales_suite_create_task": {
      const task = pick(args, [
        "title", "description", "due_date", "owner_id", "status",
        "task_type_id", "outcome_id", "targetable_type", "targetable_id", "collaborators",
      ]);
      const res = await http.post("/tasks", { task });
      return sanitizeNotesInPayload({ success: true, task: res.data.task ?? res.data });
    }

    case "freshsales_suite_update_task": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      const task = pick(args, [
        "title", "description", "due_date", "owner_id", "status",
        "task_type_id", "outcome_id", "targetable_type", "targetable_id",
      ]);
      const res = await http.put(`/tasks/${id}`, { task });
      return sanitizeNotesInPayload({ success: true, id, task: res.data.task ?? res.data });
    }

    case "freshsales_suite_find_task": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      const res = await http.get(`/tasks/${id}`);
      return sanitizeNotesInPayload({ success: true, task: res.data.task ?? res.data });
    }

    case "freshsales_suite_list_tasks": {
      const params = {};
      if (args.filter) params.filter = args.filter;
      if (args.page) params.page = args.page;
      if (args.include) params.include = args.include;
      const res = await http.get("/tasks", { params });
      return sanitizeNotesInPayload({ success: true, tasks: res.data.tasks ?? res.data });
    }

    case "freshsales_suite_delete_task": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      await http.delete(`/tasks/${id}`);
      return { success: true, id, deleted: true };
    }

    case "freshsales_suite_mark_task_done": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      const res = await http.put(`/tasks/${id}`, { task: { status: 1 } });
      return sanitizeNotesInPayload({ success: true, id, task: res.data.task ?? res.data });
    }

    // ── Appointments ────────────────────────────────────────────────────

    case "freshsales_suite_create_meeting": {
      const appointment = pick(args, [
        "title", "description", "from_date", "end_date",
        "time_zone", "location", "targetable_type", "targetable_id", "attendees",
      ]);
      const res = await http.post("/appointments", { appointment });
      return sanitizeNotesInPayload({ success: true, appointment: res.data.appointment ?? res.data });
    }

    case "freshsales_suite_update_meeting": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      const appointment = pick(args, [
        "title", "description", "from_date", "end_date",
        "time_zone", "location", "targetable_type", "targetable_id", "attendees",
      ]);
      const res = await http.put(`/appointments/${id}`, { appointment });
      return sanitizeNotesInPayload({ success: true, id, appointment: res.data.appointment ?? res.data });
    }

    case "freshsales_suite_find_meeting": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      const res = await http.get(`/appointments/${id}`);
      return sanitizeNotesInPayload({ success: true, appointment: res.data.appointment ?? res.data });
    }

    case "freshsales_suite_list_meetings": {
      const params = {};
      if (args.filter) params.filter = args.filter;
      if (args.page) params.page = args.page;
      if (args.include) params.include = args.include;
      const res = await http.get("/appointments", { params });
      return sanitizeNotesInPayload({ success: true, appointments: res.data.appointments ?? res.data });
    }

    case "freshsales_suite_delete_meeting": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      await http.delete(`/appointments/${id}`);
      return { success: true, id, deleted: true };
    }

    // ── Sales Activities ────────────────────────────────────────────────

    case "freshsales_suite_create_custom_sales_activity": {
      const sales_activity = pick(args, [
        "title", "notes", "start_date", "end_date",
        "sales_activity_type_id", "sales_activity_outcome_id",
        "owner_id", "targetable_type", "targetable_id",
        "duration", "location", "collaborators",
      ]);
      const res = await http.post("/sales_activities", { sales_activity });
      return sanitizeNotesInPayload({ success: true, sales_activity: res.data.sales_activity ?? res.data });
    }

    case "freshsales_suite_update_sales_activity": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      const sales_activity = pick(args, [
        "title", "notes", "start_date", "end_date",
        "sales_activity_type_id", "sales_activity_outcome_id",
        "owner_id", "targetable_type", "targetable_id",
        "duration", "location",
      ]);
      const res = await http.put(`/sales_activities/${id}`, { sales_activity });
      return sanitizeNotesInPayload({ success: true, id, sales_activity: res.data.sales_activity ?? res.data });
    }

    case "freshsales_suite_find_sales_activity": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      const res = await http.get(`/sales_activities/${id}`);
      return sanitizeNotesInPayload({ success: true, sales_activity: res.data.sales_activity ?? res.data });
    }

    case "freshsales_suite_list_sales_activities": {
      const params = {};
      if (args.page) params.page = args.page;
      if (args.include) params.include = args.include;
      const res = await http.get("/sales_activities", { params });
      return sanitizeNotesInPayload({ success: true, sales_activities: res.data.sales_activities ?? res.data });
    }

    case "freshsales_suite_delete_sales_activity": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      await http.delete(`/sales_activities/${id}`);
      return { success: true, id, deleted: true };
    }

    // ── Notes ───────────────────────────────────────────────────────────

    case "freshsales_suite_add_note_to_contact": {
      const id = await resolveContactId(http, args.update_by, args.value_for_update_by);
      const note = { description: args.note__description, targetable_type: "Contact", targetable_id: id };
      const res = await http.post("/notes", { note });
      return sanitizeNotesInPayload({ success: true, id, note: sanitizeNoteResponse(res.data.note ?? res.data) });
    }

    case "freshsales_suite_add_note": {
      const note = {
        description: args.note_input,
        targetable_type: mapTargetableType(args.module_type),
        targetable_id: args.targetable_id,
      };
      const res = await http.post("/notes", { note });
      return sanitizeNotesInPayload({ success: true, note: sanitizeNoteResponse(res.data.note ?? res.data) });
    }

    case "freshsales_suite_update_note": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      const res = await http.put(`/notes/${id}`, { note: { description: args.description } });
      return sanitizeNotesInPayload({ success: true, id, note: sanitizeNoteResponse(res.data.note ?? res.data) });
    }

    case "freshsales_suite_delete_note": {
      const id = parseId(args.id);
      if (!id) throw new Error("id is required");
      await http.delete(`/notes/${id}`);
      return { success: true, id, deleted: true };
    }

    // ── Files ───────────────────────────────────────────────────────────

    case "freshsales_suite_add_file": {
      const fileBuffer = await fs.readFile(args.file_path);
      const form = new FormData();
      const finalFileName = args.file_name || path.basename(args.file_path);
      form.append("file", new Blob([fileBuffer]), finalFileName);
      form.append("targetable_type", mapTargetableType(args.select_one_module));
      form.append("targetable_id", String(args.unique_identifier));
      if (isDefined(args.share_with_team)) form.append("share_with_team", String(args.share_with_team));
      const res = await http.post("/documents", form, { headers: { ...form.getHeaders?.() } });
      return sanitizeNotesInPayload({ success: true, file: res.data.document ?? res.data });
    }

    // ── Marketing Events ────────────────────────────────────────────────

    case "freshsales_suite_create_a_marketing_event": {
      const event = {
        event_name: args.event_name,
        unique_identifer_name: args.unique_identifer_name,
        unique_identifier: args.unique_identifier,
        additional_event_properties: args.additional_event_properties,
      };
      let res;
      try {
        res = await http.post("/events", { event });
      } catch (err) {
        if (err?.response?.status !== 404) throw err;
        res = await http.post("/marketing_events", { event });
      }
      return sanitizeNotesInPayload({ success: true, event: res.data.event ?? res.data });
    }

    // ── Custom Modules ──────────────────────────────────────────────────

    case "freshsales_suite_create_a_record_on_custom_module": {
      const moduleName = args.module_name;
      const record = args.fields ?? {};
      let res;
      try {
        res = await http.post(`/custom_module/${encodeURIComponent(moduleName)}`, record);
      } catch (err) {
        if (err?.response?.status !== 404) throw err;
        res = await http.post(`/custom_module/${encodeURIComponent(moduleName)}/records`, { record });
      }
      return sanitizeNotesInPayload({ success: true, module_name: moduleName, record: res.data.record ?? res.data });
    }

    // ── Users ───────────────────────────────────────────────────────────

    case "freshsales_suite_find_user": {
      let users = [];
      try {
        const res = await http.get("/users", { params: { email: args.email_id_of_the_user } });
        users = Array.isArray(res.data?.users) ? res.data.users : Array.isArray(res.data) ? res.data : [res.data].filter(Boolean);
      } catch (err) {
        if (err?.response?.status !== 404) throw err;
      }
      if (!users.length) {
        const res = await http.get("/users");
        const all = Array.isArray(res.data?.users) ? res.data.users : Array.isArray(res.data) ? res.data : [res.data].filter(Boolean);
        const target = args.email_id_of_the_user.toString().toLowerCase();
        users = all.filter((u) => (u.email ?? "").toString().toLowerCase() === target);
      }
      return sanitizeNotesInPayload({ success: true, email_id_of_the_user: args.email_id_of_the_user, users, user: users[0] ?? null });
    }

    // ── Search & Lookup ─────────────────────────────────────────────────

    case "freshsales_suite_search": {
      const params = { q: args.q };
      if (args.include) params.include = args.include;
      const res = await http.get("/search", { params });
      return sanitizeNotesInPayload({ success: true, ...res.data });
    }

    case "freshsales_suite_lookup": {
      const res = await http.get("/lookup", { params: { q: args.q, f: args.f, entities: args.entities } });
      return sanitizeNotesInPayload({ success: true, ...res.data });
    }

    // ── Selectors / Configuration ───────────────────────────────────────

    case "freshsales_suite_get_selector": {
      const selectorType = args.selector_type;
      let endpoint = `/selector/${selectorType}`;
      // Handle nested selectors like deal_pipelines/:id/deal_stages
      if (args.parent_id) {
        const parentType = selectorType === "deal_stages" ? "deal_pipelines" : selectorType === "sales_activity_outcomes" ? "sales_activity_types" : null;
        if (parentType) endpoint = `/selector/${parentType}/${parseId(args.parent_id)}/${selectorType}`;
      }
      const res = await http.get(endpoint);
      return { success: true, selector_type: selectorType, data: res.data };
    }

    // ── Marketing Lists ─────────────────────────────────────────────────

    case "freshsales_suite_create_list": {
      const res = await http.post("/lists", { name: args.name });
      return { success: true, list: res.data.list ?? res.data };
    }

    case "freshsales_suite_list_lists": {
      const res = await http.get("/lists");
      return { success: true, lists: res.data.lists ?? res.data };
    }

    case "freshsales_suite_add_contacts_to_list": {
      const listId = parseId(args.list_id);
      if (!listId) throw new Error("list_id is required");
      const res = await http.put(`/lists/${listId}/add_contacts`, { ids: args.ids });
      return { success: true, list_id: listId, ...res.data };
    }

    case "freshsales_suite_remove_contacts_from_list": {
      const listId = parseId(args.list_id);
      if (!listId) throw new Error("list_id is required");
      const payload = args.ids?.length ? { ids: args.ids } : { all: true };
      const res = await http.put(`/lists/${listId}/remove_contacts`, payload);
      return { success: true, list_id: listId, ...res.data };
    }

    // ── Phone Calls ─────────────────────────────────────────────────────

    case "freshsales_suite_log_phone_call": {
      const phone_call = pick(args, ["contact_id", "deal_id", "note", "duration", "call_direction", "call_type"]);
      const res = await http.post("/phone_calls", { phone_call });
      return sanitizeNotesInPayload({ success: true, phone_call: res.data.phone_call ?? res.data });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
