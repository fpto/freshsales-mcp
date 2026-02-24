import axios from "axios";
import fs from "node:fs/promises";
import path from "node:path";

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
  appointments: "Appointment",
};

const isDefined = (value) => value !== undefined && value !== null;

const setNested = (target, pathParts, value) => {
  let cursor = target;
  for (let i = 0; i < pathParts.length; i += 1) {
    const key = pathParts[i];
    const isLast = i === pathParts.length - 1;

    if (isLast) {
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
    const pathParts = key.slice(token.length).split("__").filter(Boolean);
    if (!pathParts.length) continue;
    setNested(payload, pathParts, value);
  }

  return payload;
};

const parseId = (value) => {
  if (!isDefined(value)) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const normalizeSearchField = (value = "") => value.toString().trim().toLowerCase();

const mapTargetableType = (moduleType = "") => {
  const normalized = moduleType.toString().trim().toLowerCase();
  return MODULE_TYPE_MAP[normalized] || moduleType;
};

const firstArrayItem = (value) => (Array.isArray(value) && value.length ? value[0] : null);
const NOTE_TEXT_FIELDS = ["description", "description_text", "body", "note", "text"];

const isHtmlDocument = (value) =>
  typeof value === "string" && /<\s*!doctype\s+html|<\s*html[\s>]/i.test(value);

const stripHtml = (value = "") =>
  value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();

const cleanNoteText = (value) => {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  return stripHtml(trimmed);
};

const sanitizeNoteResponse = (rawNote) => {
  if (!isDefined(rawNote)) return rawNote;

  if (typeof rawNote === "string") {
    if (isHtmlDocument(rawNote)) {
      return { text: "", raw_html_filtered: true };
    }
    return { text: cleanNoteText(rawNote) };
  }

  if (Array.isArray(rawNote)) {
    return rawNote.map((item) => sanitizeNoteResponse(item));
  }

  if (typeof rawNote === "object") {
    const out = { ...rawNote };
    for (const field of NOTE_TEXT_FIELDS) {
      if (isDefined(out[field])) {
        out[field] = cleanNoteText(out[field]);
      }
    }

    // If API unexpectedly returned HTML in a text field, surface only clean text.
    if (NOTE_TEXT_FIELDS.some((field) => isHtmlDocument(rawNote[field]))) {
      out.raw_html_filtered = true;
    }

    return out;
  }

  return rawNote;
};

const sanitizeNotesInPayload = (value, keyHint = "") => {
  if (!isDefined(value)) return value;

  if (Array.isArray(value)) {
    if (keyHint === "notes") {
      return value.map((item) => sanitizeNoteResponse(item));
    }
    return value.map((item) => sanitizeNotesInPayload(item, keyHint));
  }

  if (typeof value === "object") {
    if (keyHint === "note" || keyHint === "last_note") {
      return sanitizeNoteResponse(value);
    }

    const out = {};
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey === "note" || normalizedKey === "last_note") {
        out[key] = sanitizeNoteResponse(child);
      } else if (normalizedKey === "notes") {
        if (Array.isArray(child)) {
          out[key] = child.map((item) => sanitizeNoteResponse(item));
        } else {
          out[key] = sanitizeNoteResponse(child);
        }
      } else {
        out[key] = sanitizeNotesInPayload(child, normalizedKey);
      }
    }
    return out;
  }

  return value;
};

async function searchByInclude(http, include, q) {
  const res = await http.get("/search", {
    params: { q, include },
  });

  return res.data;
}

function extractEntityFromSearch(raw, preferredKey) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.results)) return raw.results;
  if (Array.isArray(raw[preferredKey])) return raw[preferredKey];
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.data)) return raw.data;
  return [];
}

async function findContactInternal(http, searchBy, valueForFindBy) {
  const field = normalizeSearchField(searchBy);
  const id = parseId(valueForFindBy);

  if (field === "contact_id" || field === "id" || field === "contact id") {
    if (!id) {
      throw new Error("value_for_find_by must be numeric when search_by is contact id");
    }

    const res = await http.get(`/contacts/${id}`);
    return {
      search_by: searchBy,
      value_for_find_by: valueForFindBy,
      matches: [res.data.contact ?? res.data],
      exact_match: res.data.contact ?? res.data,
    };
  }

  const raw = await searchByInclude(http, "contact", valueForFindBy);
  const matches = extractEntityFromSearch(raw, "contacts");
  const exact =
    matches.find((item) => {
      const email = item.email ?? item.work_email ?? firstArrayItem(item.emails)?.email;
      const mobile = item.mobile_number ?? item.phone_number;
      const external = item.external_id;

      if (field.includes("email")) return email?.toString().toLowerCase() === valueForFindBy.toString().toLowerCase();
      if (field.includes("phone") || field.includes("mobile")) return mobile?.toString() === valueForFindBy.toString();
      if (field.includes("external")) return external?.toString() === valueForFindBy.toString();
      return false;
    }) ?? null;

  return {
    search_by: searchBy,
    value_for_find_by: valueForFindBy,
    matches,
    exact_match: exact,
    raw,
  };
}

async function resolveContactId(http, updateBy, valueForUpdateBy) {
  const field = normalizeSearchField(updateBy);
  const directId = parseId(valueForUpdateBy);
  if (field === "contact_id" || field === "id" || field === "contact id") {
    if (!directId) throw new Error("value_for_update_by must be numeric when update_by is contact id");
    return directId;
  }

  const found = await findContactInternal(http, updateBy, valueForUpdateBy);
  const candidate = found.exact_match ?? found.matches[0];
  const foundId = parseId(candidate?.id ?? candidate?.contact_id);
  if (!foundId) throw new Error("Could not resolve contact id from update_by/value_for_update_by");
  return foundId;
}

async function findAccountInternal(http, searchBy, valueForFindBy) {
  const field = normalizeSearchField(searchBy);
  const id = parseId(valueForFindBy);

  if (field === "account_id" || field === "id" || field === "account id") {
    if (!id) throw new Error("value_for_find_by must be numeric when search_by is account id");
    const res = await http.get(`/sales_accounts/${id}`);
    return {
      search_by: searchBy,
      value_for_find_by: valueForFindBy,
      matches: [res.data.sales_account ?? res.data],
      exact_match: res.data.sales_account ?? res.data,
    };
  }

  const raw = await searchByInclude(http, "sales_account", valueForFindBy);
  const matches = extractEntityFromSearch(raw, "sales_accounts");
  const exact =
    matches.find((item) =>
      (item.name ?? "").toString().toLowerCase() === valueForFindBy.toString().toLowerCase(),
    ) ?? null;

  return {
    search_by: searchBy,
    value_for_find_by: valueForFindBy,
    matches,
    exact_match: exact,
    raw,
  };
}

async function resolveAccountId(http, updateBy, valueForUpdateBy) {
  const field = normalizeSearchField(updateBy);
  const directId = parseId(valueForUpdateBy);
  if (field === "account_id" || field === "id" || field === "account id") {
    if (!directId) throw new Error("value_for_update_by must be numeric when update_by is account id");
    return directId;
  }

  const found = await findAccountInternal(http, updateBy, valueForUpdateBy);
  const candidate = found.exact_match ?? found.matches[0];
  const foundId = parseId(candidate?.id ?? candidate?.sales_account_id);
  if (!foundId) throw new Error("Could not resolve account id from update_by/value_for_update_by");
  return foundId;
}

async function findDealInternal(http, findByNameOrId, valueForFindDeal) {
  const field = normalizeSearchField(findByNameOrId);
  const id = parseId(valueForFindDeal);

  if (field === "deal_id" || field === "id" || field === "deal id") {
    if (!id) throw new Error("value_for_find_deal must be numeric when find_by_name_or_id is deal id");
    const res = await http.get(`/deals/${id}`);
    return {
      find_by_name_or_id: findByNameOrId,
      value_for_find_deal: valueForFindDeal,
      matches: [res.data.deal ?? res.data],
      exact_match: res.data.deal ?? res.data,
    };
  }

  const raw = await searchByInclude(http, "deal", valueForFindDeal);
  const matches = extractEntityFromSearch(raw, "deals");
  const exact =
    matches.find((item) =>
      (item.name ?? "").toString().toLowerCase() === valueForFindDeal.toString().toLowerCase(),
    ) ?? null;

  return {
    find_by_name_or_id: findByNameOrId,
    value_for_find_deal: valueForFindDeal,
    matches,
    exact_match: exact,
    raw,
  };
}

function createSchema(properties, required = []) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties: true,
  };
}

export function getTools() {
  return [
    {
      name: "freshsales_suite_create_contact",
      description: "Crea un nuevo contacto en Freshsales Suite.",
      inputSchema: createSchema({
        contact__first_name: { type: "string" },
        contact__last_name: { type: "string" },
        contact__work_email: { type: "string" },
        contact__mobile_number: { type: "string" },
        contact__work_number: { type: "string" },
        contact__phone_numbers: { type: "array", items: { type: "string" } },
        contact__job_title: { type: "string" },
        contact__sales_account__name: { type: "string" },
        contact__address: { type: "string" },
        contact__city: { type: "string" },
        contact__state: { type: "string" },
        contact__country: { type: "string" },
        contact__zipcode: { type: "string" },
        contact__lead_score: { type: ["number", "string"] },
        contact__lead_source_id: { type: ["number", "string"] },
        contact__owner_id: { type: ["number", "string"] },
        contact__territory_id: { type: ["number", "string"] },
        contact__tags: { type: "array", items: { type: "string" } },
        contact__subscription_status: { type: "string" },
        contact__subscription_types: { type: "array", items: { type: "string" } },
        contact__emails: { type: "array", items: { type: ["string", "object"] } },
      }),
    },
    {
      name: "freshsales_suite_update_contact",
      description: "Actualiza un contacto existente en Freshsales Suite.",
      inputSchema: createSchema(
        {
          update_by: { type: "string" },
          value_for_update_by: { type: ["string", "number"] },
          list_operation: { type: "string" },
          list_name: { type: "string" },
          lifecycle_stage: { type: ["string", "object"] },
          contact__first_name: { type: "string" },
          contact__last_name: { type: "string" },
          contact__work_email: { type: "string" },
          contact__mobile_number: { type: "string" },
          contact__work_number: { type: "string" },
          contact__phone_numbers: { type: "array", items: { type: "string" } },
          contact__job_title: { type: "string" },
          contact__sales_account__name: { type: "string" },
          contact__address: { type: "string" },
          contact__city: { type: "string" },
          contact__state: { type: "string" },
          contact__country: { type: "string" },
          contact__zipcode: { type: "string" },
          contact__lead_score: { type: ["number", "string"] },
          contact__lead_source_id: { type: ["number", "string"] },
          contact__owner_id: { type: ["number", "string"] },
          contact__territory_id: { type: ["number", "string"] },
          contact__tags: { type: "array", items: { type: "string" } },
          contact__subscription_status: { type: "string" },
          contact__subscription_types: { type: "array", items: { type: "string" } },
          contact__emails: { type: "array", items: { type: ["string", "object"] } },
        },
        ["update_by", "value_for_update_by"],
      ),
    },
    {
      name: "freshsales_suite_find_contact_by_unique_fields",
      description: "Busca un contacto existente por campos únicos.",
      inputSchema: createSchema(
        {
          search_by: { type: "string" },
          value_for_find_by: { type: ["string", "number"] },
        },
        ["search_by", "value_for_find_by"],
      ),
    },
    {
      name: "freshsales_suite_create_account",
      description: "Crea una nueva cuenta (empresa/organización).",
      inputSchema: createSchema({
        sales_account__name: { type: "string" },
        sales_account__website: { type: "string" },
        sales_account__phone: { type: "string" },
        sales_account__address: { type: "string" },
        sales_account__city: { type: "string" },
        sales_account__state: { type: "string" },
        sales_account__country: { type: "string" },
        sales_account__zipcode: { type: "string" },
        sales_account__industry_type_id: { type: ["number", "string"] },
        sales_account__business_type_id: { type: ["number", "string"] },
        sales_account__number_of_employees: { type: ["number", "string"] },
        sales_account__annual_revenue: { type: ["number", "string"] },
        sales_account__owner_id: { type: ["number", "string"] },
        sales_account__territory_id: { type: ["number", "string"] },
        sales_account__tags: { type: "array", items: { type: "string" } },
        sales_account__facebook: { type: "string" },
        sales_account__twitter: { type: "string" },
        sales_account__linkedin: { type: "string" },
      }),
    },
    {
      name: "freshsales_suite_update_account",
      description: "Actualiza una cuenta existente.",
      inputSchema: createSchema(
        {
          update_by: { type: "string" },
          value_for_update_by: { type: ["string", "number"] },
          sales_account__name: { type: "string" },
          sales_account__website: { type: "string" },
          sales_account__phone: { type: "string" },
          sales_account__address: { type: "string" },
          sales_account__city: { type: "string" },
          sales_account__state: { type: "string" },
          sales_account__country: { type: "string" },
          sales_account__zipcode: { type: "string" },
          sales_account__industry_type_id: { type: ["number", "string"] },
          sales_account__business_type_id: { type: ["number", "string"] },
          sales_account__number_of_employees: { type: ["number", "string"] },
          sales_account__annual_revenue: { type: ["number", "string"] },
          sales_account__owner_id: { type: ["number", "string"] },
          sales_account__territory_id: { type: ["number", "string"] },
          sales_account__tags: { type: "array", items: { type: "string" } },
          sales_account__facebook: { type: "string" },
          sales_account__twitter: { type: "string" },
          sales_account__linkedin: { type: "string" },
        },
        ["update_by", "value_for_update_by"],
      ),
    },
    {
      name: "freshsales_suite_find_account",
      description: "Busca una cuenta existente.",
      inputSchema: createSchema(
        {
          search_by: { type: "string" },
          value_for_find_by: { type: ["string", "number"] },
        },
        ["search_by", "value_for_find_by"],
      ),
    },
    {
      name: "freshsales_suite_create_deal",
      description: "Crea una nueva oportunidad de venta (deal).",
      inputSchema: createSchema({
        deal__name: { type: "string" },
        deal__amount: { type: ["number", "string"] },
        deal__currency_id: { type: ["number", "string"] },
        deal__deal_pipeline_id: { type: ["number", "string"] },
        deal__deal_stage_id: { type: ["number", "string"] },
        deal__deal_type_id: { type: ["number", "string"] },
        deal__expected_close: { type: "string" },
        deal__owner_id: { type: ["number", "string"] },
        deal__sales_account__name: { type: "string" },
        deal__contacts_added_list: { type: "array", items: { type: ["string", "number"] } },
        deal__probability: { type: ["number", "string"] },
        deal__lead_source_id: { type: ["number", "string"] },
        deal__territory_id: { type: ["number", "string"] },
        deal__tags: { type: "array", items: { type: "string" } },
        deal__deal_payment_status_id: { type: ["number", "string"] },
        deal__deal_reason_id: { type: ["number", "string"] },
        deal__forecast_category: { type: "string" },
      }),
    },
    {
      name: "freshsales_suite_update_deal",
      description: "Actualiza un deal existente.",
      inputSchema: createSchema(
        {
          value_for_update_by: { type: ["number", "string"] },
          deal__name: { type: "string" },
          deal__amount: { type: ["number", "string"] },
          deal__currency_id: { type: ["number", "string"] },
          deal__deal_pipeline_id: { type: ["number", "string"] },
          deal__deal_stage_id: { type: ["number", "string"] },
          deal__deal_type_id: { type: ["number", "string"] },
          deal__expected_close: { type: "string" },
          deal__owner_id: { type: ["number", "string"] },
          deal__sales_account__name: { type: "string" },
          deal__contacts_added_list: { type: "array", items: { type: ["string", "number"] } },
          deal__probability: { type: ["number", "string"] },
          deal__lead_source_id: { type: ["number", "string"] },
          deal__territory_id: { type: ["number", "string"] },
          deal__tags: { type: "array", items: { type: "string" } },
          deal__deal_payment_status_id: { type: ["number", "string"] },
          deal__deal_reason_id: { type: ["number", "string"] },
          deal__forecast_category: { type: "string" },
        },
        ["value_for_update_by"],
      ),
    },
    {
      name: "freshsales_suite_find_deal",
      description: "Busca un deal existente.",
      inputSchema: createSchema(
        {
          find_by_name_or_id: { type: "string" },
          value_for_find_deal: { type: ["string", "number"] },
        },
        ["find_by_name_or_id", "value_for_find_deal"],
      ),
    },
    {
      name: "freshsales_suite_create_task",
      description: "Crea una tarea en Freshsales Suite.",
      inputSchema: createSchema({
        title: { type: "string" },
        description: { type: "string" },
        due_date: { type: "string" },
        task_type_id: { type: ["number", "string"] },
        owner_id: { type: ["number", "string"] },
        associated_modules: { type: ["string", "object"] },
        outcome_id: { type: ["number", "string"] },
        collaborators: { type: "array", items: { type: ["number", "string"] } },
      }),
    },
    {
      name: "freshsales_suite_create_meeting",
      description: "Agrega una reunión a un módulo seleccionado.",
      inputSchema: createSchema({
        title: { type: "string" },
        description: { type: "string" },
        from_date: { type: "string" },
        to_date: { type: "string" },
        location: { type: "string" },
        time_zone: { type: "string" },
        outcome: { type: ["string", "object"] },
        associated_module: { type: "string" },
        targetable_id: { type: ["number", "string"] },
        attendees_email: { type: "array", items: { type: "string" } },
      }),
    },
    {
      name: "freshsales_suite_create_custom_sales_activity",
      description: "Crea una actividad de venta personalizada.",
      inputSchema: createSchema({
        title: { type: "string" },
        custom_sales_activity: { type: ["string", "number"] },
        start_date: { type: "string" },
        end_date: { type: "string" },
        notes: { type: "string" },
        location: { type: "string" },
        outcome: { type: ["string", "object"] },
        associated_module: { type: "string" },
        targetable_id: { type: ["number", "string"] },
        owner_id: { type: ["number", "string"] },
        collaborators: { type: "array", items: { type: ["number", "string"] } },
      }),
    },
    {
      name: "freshsales_suite_add_note_to_contact",
      description: "Agrega una nota a un contacto.",
      inputSchema: createSchema(
        {
          note__description: { type: "string" },
          update_by: { type: "string" },
          value_for_update_by: { type: ["string", "number"] },
        },
        ["note__description", "update_by", "value_for_update_by"],
      ),
    },
    {
      name: "freshsales_suite_add_note",
      description: "Crea una nota en un módulo seleccionado.",
      inputSchema: createSchema(
        {
          note_input: { type: "string" },
          module_type: { type: "string" },
          targetable_id: { type: ["number", "string"] },
        },
        ["note_input", "module_type", "targetable_id"],
      ),
    },
    {
      name: "freshsales_suite_add_file",
      description: "Agrega un archivo a registros de módulos seleccionados.",
      inputSchema: createSchema(
        {
          file_name: { type: "string" },
          file_path: { type: "string" },
          select_one_module: { type: "string" },
          unique_identifier: { type: ["string", "number"] },
          share_with_team: { type: ["boolean", "string"] },
        },
        ["file_name", "file_path", "select_one_module", "unique_identifier"],
      ),
    },
    {
      name: "freshsales_suite_create_a_marketing_event",
      description:
        "Crea un evento de marketing (solo para Freshsales Suite y Freshmarketer).",
      inputSchema: createSchema({
        event_name: { type: "string" },
        unique_identifer_name: { type: "string" },
        unique_identifier: { type: ["string", "number"] },
        additional_event_properties: { type: ["object", "array", "string"] },
      }),
    },
    {
      name: "freshsales_suite_create_a_record_on_custom_module",
      description: "Crea un nuevo registro en un módulo personalizado.",
      inputSchema: createSchema(
        {
          module_name: { type: "string" },
          fields: { type: "object" },
        },
        ["module_name"],
      ),
    },
    {
      name: "freshsales_suite_find_user",
      description: "Busca un usuario existente por correo electrónico.",
      inputSchema: createSchema(
        {
          email_id_of_the_user: { type: "string" },
        },
        ["email_id_of_the_user"],
      ),
    },
  ];
}

const pick = (args, keys) => {
  const out = {};
  for (const key of keys) {
    if (isDefined(args[key])) out[key] = args[key];
  }
  return out;
};

export async function runTool(http, name, args = {}) {
  switch (name) {
    case "freshsales_suite_create_contact": {
      const contact = buildPrefixedObject(args, "contact");
      const res = await http.post("/contacts", { contact });
      return sanitizeNotesInPayload({ success: true, contact: res.data.contact ?? res.data });
    }

    case "freshsales_suite_update_contact": {
      const id = await resolveContactId(http, args.update_by, args.value_for_update_by);
      const contact = buildPrefixedObject(args, "contact");
      const controlFields = pick(args, ["list_operation", "list_name", "lifecycle_stage"]);
      const payload = Object.keys(controlFields).length ? { ...contact, ...controlFields } : contact;
      const res = await http.put(`/contacts/${id}`, { contact: payload });
      return sanitizeNotesInPayload({
        success: true,
        id,
        contact: res.data.contact ?? res.data,
      });
    }

    case "freshsales_suite_find_contact_by_unique_fields": {
      const result = await findContactInternal(http, args.search_by, args.value_for_find_by);
      return sanitizeNotesInPayload({ success: true, ...result });
    }

    case "freshsales_suite_create_account": {
      const sales_account = buildPrefixedObject(args, "sales_account");
      const res = await http.post("/sales_accounts", { sales_account });
      return sanitizeNotesInPayload({
        success: true,
        sales_account: res.data.sales_account ?? res.data,
      });
    }

    case "freshsales_suite_update_account": {
      const id = await resolveAccountId(http, args.update_by, args.value_for_update_by);
      const sales_account = buildPrefixedObject(args, "sales_account");
      const res = await http.put(`/sales_accounts/${id}`, { sales_account });
      return sanitizeNotesInPayload({
        success: true,
        id,
        sales_account: res.data.sales_account ?? res.data,
      });
    }

    case "freshsales_suite_find_account": {
      const result = await findAccountInternal(http, args.search_by, args.value_for_find_by);
      return sanitizeNotesInPayload({ success: true, ...result });
    }

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

    case "freshsales_suite_create_task": {
      const task = {
        ...pick(args, [
          "title",
          "description",
          "due_date",
          "task_type_id",
          "owner_id",
          "associated_modules",
          "outcome_id",
          "collaborators",
        ]),
      };
      const res = await http.post("/tasks", { task });
      return sanitizeNotesInPayload({ success: true, task: res.data.task ?? res.data });
    }

    case "freshsales_suite_create_meeting": {
      const appointment = {
        ...pick(args, [
          "title",
          "description",
          "from_date",
          "to_date",
          "location",
          "time_zone",
          "outcome",
          "attendees_email",
        ]),
        targetable_type: mapTargetableType(args.associated_module),
        targetable_id: args.targetable_id,
      };
      const res = await http.post("/appointments", { appointment });
      return sanitizeNotesInPayload({
        success: true,
        appointment: res.data.appointment ?? res.data,
      });
    }

    case "freshsales_suite_create_custom_sales_activity": {
      const sales_activity = {
        ...pick(args, [
          "title",
          "custom_sales_activity",
          "start_date",
          "end_date",
          "notes",
          "location",
          "outcome",
          "owner_id",
          "collaborators",
        ]),
        targetable_type: mapTargetableType(args.associated_module),
        targetable_id: args.targetable_id,
      };
      const res = await http.post("/sales_activities", { sales_activity });
      return sanitizeNotesInPayload({
        success: true,
        sales_activity: res.data.sales_activity ?? res.data,
      });
    }

    case "freshsales_suite_add_note_to_contact": {
      const id = await resolveContactId(http, args.update_by, args.value_for_update_by);
      const note = {
        description: args.note__description,
        targetable_type: "Contact",
        targetable_id: id,
      };
      const res = await http.post("/notes", { note });
      return sanitizeNotesInPayload({
        success: true,
        id,
        note: sanitizeNoteResponse(res.data.note ?? res.data),
      });
    }

    case "freshsales_suite_add_note": {
      const note = {
        description: args.note_input,
        targetable_type: mapTargetableType(args.module_type),
        targetable_id: args.targetable_id,
      };
      const res = await http.post("/notes", { note });
      return sanitizeNotesInPayload({
        success: true,
        note: sanitizeNoteResponse(res.data.note ?? res.data),
      });
    }

    case "freshsales_suite_add_file": {
      const fileBuffer = await fs.readFile(args.file_path);
      const form = new FormData();
      const finalFileName = args.file_name || path.basename(args.file_path);
      form.append("file", new Blob([fileBuffer]), finalFileName);
      form.append("targetable_type", mapTargetableType(args.select_one_module));
      form.append("targetable_id", String(args.unique_identifier));
      if (isDefined(args.share_with_team)) {
        form.append("share_with_team", String(args.share_with_team));
      }

      const res = await http.post("/files", form, {
        headers: {
          ...form.getHeaders?.(),
        },
      });
      return sanitizeNotesInPayload({ success: true, file: res.data.file ?? res.data });
    }

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
      } catch (error) {
        if (error?.response?.status !== 404) throw error;
        res = await http.post("/marketing_events", { event });
      }

      return sanitizeNotesInPayload({ success: true, event: res.data.event ?? res.data });
    }

    case "freshsales_suite_create_a_record_on_custom_module": {
      const moduleName = args.module_name;
      const record = args.fields ?? {};

      let res;
      try {
        res = await http.post(`/custom_modules/${encodeURIComponent(moduleName)}/records`, {
          record,
        });
      } catch (error) {
        if (error?.response?.status !== 404) throw error;
        res = await http.post("/custom_module_records", {
          module_name: moduleName,
          record,
        });
      }

      return sanitizeNotesInPayload({
        success: true,
        module_name: moduleName,
        record: res.data.record ?? res.data,
      });
    }

    case "freshsales_suite_find_user": {
      let users = [];
      try {
        const res = await http.get("/users", {
          params: { email: args.email_id_of_the_user },
        });
        users = Array.isArray(res.data?.users)
          ? res.data.users
          : Array.isArray(res.data)
            ? res.data
            : [res.data].filter(Boolean);
      } catch (error) {
        if (error?.response?.status !== 404) throw error;
      }

      if (!users.length) {
        const res = await http.get("/users");
        const all = Array.isArray(res.data?.users)
          ? res.data.users
          : Array.isArray(res.data)
            ? res.data
            : [res.data].filter(Boolean);
        const target = args.email_id_of_the_user.toString().toLowerCase();
        users = all.filter((user) => (user.email ?? "").toString().toLowerCase() === target);
      }

      return sanitizeNotesInPayload({
        success: true,
        email_id_of_the_user: args.email_id_of_the_user,
        users,
        user: users[0] ?? null,
      });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
