#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import http from "node:http";

// Twenty's PHONES composite field requires a calling code (+61) AND an ISO 3166-1
// alpha-2 country code (AU). Passing the calling code as the country code is a
// classic INVALID_PHONE_COUNTRY_CODE error. This table covers the codes most
// commonly seen in our pipelines; extend as needed.
const CALLING_CODE_TO_ISO = {
  "+1":   "US",  // shared with Canada; default to US — override with composite if it matters
  "+27":  "ZA",
  "+33":  "FR",
  "+34":  "ES",
  "+39":  "IT",
  "+44":  "GB",
  "+49":  "DE",
  "+52":  "MX",
  "+55":  "BR",
  "+61":  "AU",
  "+64":  "NZ",
  "+65":  "SG",
  "+81":  "JP",
  "+82":  "KR",
  "+86":  "CN",
  "+91":  "IN",
  "+971": "AE",
  "+972": "IL",
};

// Parse an E.164 string like "+61412345678" into { callingCode, iso, number }.
// Returns null if it can't be confidently parsed.
function parseE164(str) {
  const trimmed = String(str).trim();
  const m = trimmed.match(/^\+(\d{1,3})(\d+)$/);
  if (!m) return null;
  const digits = m[1];
  const rest = m[2];
  // Try longest calling code first (some are 3 digits like +971).
  for (let len = Math.min(3, digits.length); len >= 1; len--) {
    const callingCode = "+" + digits.slice(0, len);
    const iso = CALLING_CODE_TO_ISO[callingCode];
    if (iso) {
      const extraDigits = digits.slice(len);
      return { callingCode, iso, number: extraDigits + rest };
    }
  }
  return null;
}

// Normalize whatever shape Hermes (or a human) passed into the composite Twenty wants:
//   "+61412345678"
//   { primaryPhoneNumber: "412345678", primaryPhoneCountryCode: "AU", primaryPhoneCallingCode: "+61" }
//   { phones: { ...above... } }
// Returns a value safe to write to data.phones, or undefined if input is empty.
function normalizePhone(input, fallbackCountryCode) {
  if (input == null || input === "") return undefined;
  if (typeof input === "object") {
    // Allow caller to wrap in { phones: { ... } } or pass the inner object directly.
    const inner = input.phones || input;
    if (inner.primaryPhoneNumber) {
      return {
        primaryPhoneNumber: String(inner.primaryPhoneNumber),
        primaryPhoneCountryCode: inner.primaryPhoneCountryCode || fallbackCountryCode || "",
        primaryPhoneCallingCode: inner.primaryPhoneCallingCode || "",
        additionalPhones: Array.isArray(inner.additionalPhones) ? inner.additionalPhones : [],
      };
    }
    return undefined;
  }
  const parsed = parseE164(input);
  if (parsed) {
    return {
      primaryPhoneNumber: parsed.number,
      primaryPhoneCountryCode: parsed.iso,
      primaryPhoneCallingCode: parsed.callingCode,
      additionalPhones: [],
    };
  }
  // Fallback: caller passed a non-E.164 string (e.g. "0412 345 678"). Store digits-only,
  // use the configured default ISO country code, no calling code.
  const digitsOnly = String(input).replace(/\D/g, "");
  if (!digitsOnly) return undefined;
  return {
    primaryPhoneNumber: digitsOnly,
    primaryPhoneCountryCode: fallbackCountryCode || "",
    primaryPhoneCallingCode: "",
    additionalPhones: [],
  };
}

class TwentyCRMServer {
  constructor() {
    this.server = new Server(
      {
        name: "twenty-crm",
        version: "0.4.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.apiKey = process.env.TWENTY_API_KEY;
    this.baseUrl = process.env.TWENTY_BASE_URL || "https://api.twenty.com";
    // Fallback for non-E.164 phone strings that don't carry a country code.
    // Set TWENTY_DEFAULT_COUNTRY_CODE to a 2-letter ISO code (e.g. "AU") in your env.
    this.defaultCountryCode = process.env.TWENTY_DEFAULT_COUNTRY_CODE || "";

    if (!this.apiKey) {
      throw new Error("TWENTY_API_KEY environment variable is required");
    }

    this.setupToolHandlers();
  }

  async makeRequest(endpoint, method = "GET", data = null) {
    const url = `${this.baseUrl}${endpoint}`;
    const options = {
      method,
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    };

    if (data && (method === "POST" || method === "PUT" || method === "PATCH")) {
      options.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();
      return result;
    } catch (error) {
      throw new Error(`API request failed: ${error.message}`);
    }
  }

  setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          // People Management
          {
            name: "create_person",
            description: "Create a new person in Twenty CRM. Phone is auto-normalized to Twenty's PHONES composite: pass either an E.164 string (e.g. \"+61412345678\") or the composite object {primaryPhoneNumber, primaryPhoneCountryCode, primaryPhoneCallingCode}.",
            inputSchema: {
              type: "object",
              properties: {
                firstName: { type: "string", description: "First name" },
                lastName: { type: "string", description: "Last name" },
                email: { type: "string", description: "Email address" },
                phone: { type: ["string", "object"], description: "Phone — either E.164 string like '+61412345678' or composite {primaryPhoneNumber, primaryPhoneCountryCode (ISO alpha-2 like 'AU'), primaryPhoneCallingCode}. Auto-normalized." },
                jobTitle: { type: "string", description: "Job title" },
                companyId: { type: "string", description: "Company ID to associate with" },
                linkedinUrl: { type: "string", description: "LinkedIn profile URL" },
                city: { type: "string", description: "City" },
                avatarUrl: { type: "string", description: "Avatar image URL" }
              },
              required: ["firstName", "lastName"]
            }
          },
          {
            name: "get_person",
            description: "Get details of a specific person by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Person ID" }
              },
              required: ["id"]
            }
          },
          {
            name: "update_person",
            description: "Update an existing person's information. Phone follows the same auto-normalization as create_person.",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Person ID" },
                firstName: { type: "string", description: "First name" },
                lastName: { type: "string", description: "Last name" },
                email: { type: "string", description: "Email address" },
                phone: { type: ["string", "object"], description: "Phone — E.164 string or composite. See create_person for details." },
                jobTitle: { type: "string", description: "Job title" },
                companyId: { type: "string", description: "Company ID" },
                linkedinUrl: { type: "string", description: "LinkedIn profile URL" },
                city: { type: "string", description: "City" }
              },
              required: ["id"]
            }
          },
          {
            name: "list_people",
            description: "List people with optional filtering and pagination",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                search: { type: "string", description: "Search term for name or email" },
                companyId: { type: "string", description: "Filter by company ID" }
              }
            }
          },
          {
            name: "delete_person",
            description: "Delete a person from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Person ID to delete" }
              },
              required: ["id"]
            }
          },

          // Company Management
          {
            name: "create_company",
            description: "Create a new company in Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                name: { type: "string", description: "Company name" },
                domainName: { type: "string", description: "Company domain" },
                address: { type: "string", description: "Company address" },
                employees: { type: "number", description: "Number of employees" },
                linkedinUrl: { type: "string", description: "LinkedIn company URL" },
                xUrl: { type: "string", description: "X (Twitter) URL" },
                annualRecurringRevenue: { type: "number", description: "Annual recurring revenue" },
                idealCustomerProfile: { type: "boolean", description: "Is this an ideal customer profile" }
              },
              required: ["name"]
            }
          },
          {
            name: "get_company",
            description: "Get details of a specific company by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Company ID" }
              },
              required: ["id"]
            }
          },
          {
            name: "update_company",
            description: "Update an existing company's information",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Company ID" },
                name: { type: "string", description: "Company name" },
                domainName: { type: "string", description: "Company domain" },
                address: { type: "string", description: "Company address" },
                employees: { type: "number", description: "Number of employees" },
                linkedinUrl: { type: "string", description: "LinkedIn company URL" },
                annualRecurringRevenue: { type: "number", description: "Annual recurring revenue" }
              },
              required: ["id"]
            }
          },
          {
            name: "list_companies",
            description: "List companies with optional filtering and pagination",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                search: { type: "string", description: "Search term for company name" }
              }
            }
          },
          {
            name: "delete_company",
            description: "Delete a company from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Company ID to delete" }
              },
              required: ["id"]
            }
          },

          // Notes Management
          {
            name: "create_note",
            description: "Create a new note in Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Note title" },
                body: { type: "string", description: "Note content" },
                position: { type: "number", description: "Position for ordering" }
              },
              required: ["title", "body"]
            }
          },
          {
            name: "get_note",
            description: "Get details of a specific note by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Note ID" }
              },
              required: ["id"]
            }
          },
          {
            name: "list_notes",
            description: "List notes with optional filtering and pagination",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                search: { type: "string", description: "Search term for note title or content" }
              }
            }
          },
          {
            name: "update_note",
            description: "Update an existing note",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Note ID" },
                title: { type: "string", description: "Note title" },
                body: { type: "string", description: "Note content" },
                position: { type: "number", description: "Position for ordering" }
              },
              required: ["id"]
            }
          },
          {
            name: "delete_note",
            description: "Delete a note from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Note ID to delete" }
              },
              required: ["id"]
            }
          },
          {
            name: "create_note_target",
            description: "Link an existing Note to a Person via Twenty's NoteTarget join object. Twenty requires this two-step pattern — create_note first, then create_note_target to attach it to a contact. Tries `personId` field first, falls back to `targetPersonId` if the Twenty version expects that name.",
            inputSchema: {
              type: "object",
              properties: {
                noteId: { type: "string", description: "Note ID returned by create_note" },
                personId: { type: "string", description: "Person ID to attach the note to" }
              },
              required: ["noteId", "personId"]
            }
          },

          // Tasks Management
          {
            name: "create_task",
            description: "Create a new task in Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                title: { type: "string", description: "Task title" },
                body: { type: "string", description: "Task description" },
                dueAt: { type: "string", description: "Due date (ISO 8601 format)" },
                status: { type: "string", description: "Task status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                assigneeId: { type: "string", description: "ID of person assigned to task" },
                position: { type: "number", description: "Position for ordering" }
              },
              required: ["title"]
            }
          },
          {
            name: "get_task",
            description: "Get details of a specific task by ID",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task ID" }
              },
              required: ["id"]
            }
          },
          {
            name: "list_tasks",
            description: "List tasks with optional filtering and pagination",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Number of results to return (default: 20)" },
                offset: { type: "number", description: "Number of results to skip (default: 0)" },
                status: { type: "string", description: "Filter by status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                assigneeId: { type: "string", description: "Filter by assignee ID" }
              }
            }
          },
          {
            name: "update_task",
            description: "Update an existing task",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task ID" },
                title: { type: "string", description: "Task title" },
                body: { type: "string", description: "Task description" },
                dueAt: { type: "string", description: "Due date (ISO 8601 format)" },
                status: { type: "string", description: "Task status", enum: ["TODO", "IN_PROGRESS", "DONE"] },
                assigneeId: { type: "string", description: "ID of person assigned to task" }
              },
              required: ["id"]
            }
          },
          {
            name: "create_task_target",
            description: "Link an existing Task to a Person via Twenty's TaskTarget join object. Same two-step pattern as Notes — create_task first (set dueAt for scheduled commitments like appraisal visits or callbacks), then create_task_target to attach it to the contact. Tries `personId` first, falls back to `targetPersonId`.",
            inputSchema: {
              type: "object",
              properties: {
                taskId: { type: "string", description: "ID of the Task created with create_task" },
                personId: { type: "string", description: "ID of the Person to link the task to" }
              },
              required: ["taskId", "personId"]
            }
          },
          {
            name: "delete_task",
            description: "Delete a task from Twenty CRM",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "Task ID to delete" }
              },
              required: ["id"]
            }
          },

          // Metadata Operations
          {
            name: "get_metadata_objects",
            description: "Get all object types and their metadata",
            inputSchema: {
              type: "object",
              properties: {}
            }
          },
          {
            name: "get_object_metadata",
            description: "Get metadata for a specific object type",
            inputSchema: {
              type: "object",
              properties: {
                objectName: { type: "string", description: "Object name (e.g., 'people', 'companies')" }
              },
              required: ["objectName"]
            }
          },

          // Search and Enrichment
          {
            name: "search_records",
            description: "Search across multiple object types",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" },
                objectTypes: {
                  type: "array",
                  items: { type: "string" },
                  description: "Object types to search (e.g., ['people', 'companies'])"
                },
                limit: { type: "number", description: "Number of results per object type" }
              },
              required: ["query"]
            }
          },

          // PhoneCall Management (OCP fork — custom object)
          {
            name: "create_phone_call",
            description: "Upsert a PhoneCall record (custom object) in Twenty CRM to log an inbound call with its transcript. This is dedup-safe: it first looks for an existing PhoneCall with the same twilioCallSid, then for one from the same fromNumber within the last few minutes (PHONECALL_DEDUP_WINDOW_MIN, default 10) — if found it UPDATES that record (never downgrades outcome, appends a differing transcript) instead of creating a duplicate. So separate writers (this pipeline + the Retell receptionist) logging the same call merge into one record. ALWAYS populate twilioCallSid and, when known, fromNumber — they are the correlation keys. You do NOT need to call find_phone_call_by_call_sid first; this tool handles dedup.",
            inputSchema: {
              type: "object",
              properties: {
                twilioCallSid: { type: "string", description: "Twilio Call SID — REQUIRED correlation key, must be unique per call" },
                transcript: { type: "string", description: "Full call transcript text" },
                transcriptUrl: { type: "string", description: "URL to the AssemblyAI transcript" },
                recordingUrl: { type: "string", description: "URL to the Twilio audio recording" },
                assemblyaiTranscriptId: { type: "string", description: "AssemblyAI transcript ID" },
                fromNumber: { type: "string", description: "Caller's E.164 phone number" },
                toNumber: { type: "string", description: "E.164 number called (the Twilio inbound)" },
                fromCallerName: { type: "string", description: "Twilio CNAM lookup result" },
                direction: { type: "string", description: "Call direction", enum: ["inbound", "outbound"] },
                outcome: { type: "string", description: "How the call ended", enum: ["completed", "voicemail", "missed", "fallback_retell", "failover_static"] },
                startedAt: { type: "string", description: "Call start (ISO 8601 UTC)" },
                answeredAt: { type: "string", description: "When a leg answered (ISO 8601 UTC)" },
                endedAt: { type: "string", description: "Call end (ISO 8601 UTC)" },
                durationSeconds: { type: "number", description: "Total call duration in seconds" },
                answeredBy: { type: "string", description: "Who answered: 'agent_1', 'agent_2', 'retell_ai', etc." },
                fallbackChain: { type: "string", description: "JSON array of routing events as a string" },
                language: { type: "string", description: "Language code, e.g. 'en_au'" },
                confidence: { type: "number", description: "AssemblyAI overall confidence (0–1)" },
                personId: { type: "string", description: "ID of the linked Person (the caller)" }
              },
              required: ["twilioCallSid"]
            }
          },
          {
            name: "get_phone_call",
            description: "Get a PhoneCall record by ID",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "PhoneCall ID" } },
              required: ["id"]
            }
          },
          {
            name: "list_phone_calls",
            description: "List PhoneCall records with optional filter and pagination",
            inputSchema: {
              type: "object",
              properties: {
                limit: { type: "number", description: "Page size (default 20)" },
                offset: { type: "number", description: "Skip count (default 0)" },
                filter: { type: "string", description: "Twenty REST filter expression, e.g. 'twilioCallSid[eq]:CAxxxxx' or 'personId[eq]:<uuid>'" }
              }
            }
          },
          {
            name: "find_phone_call_by_call_sid",
            description: "Find an existing PhoneCall by twilioCallSid. Returns the record or a 'not found' message. Note: create_phone_call now dedups on its own, so this is only needed for explicit lookups, not as a pre-create guard.",
            inputSchema: {
              type: "object",
              properties: { twilioCallSid: { type: "string", description: "Twilio Call SID to search for" } },
              required: ["twilioCallSid"]
            }
          },
          {
            name: "update_phone_call",
            description: "Update fields on an existing PhoneCall (e.g., to backfill a missing field, link a Person after reconciliation, or correct a value)",
            inputSchema: {
              type: "object",
              properties: {
                id: { type: "string", description: "PhoneCall ID" },
                transcript: { type: "string" },
                transcriptUrl: { type: "string" },
                recordingUrl: { type: "string" },
                assemblyaiTranscriptId: { type: "string" },
                fromNumber: { type: "string" },
                toNumber: { type: "string" },
                fromCallerName: { type: "string" },
                direction: { type: "string", enum: ["inbound", "outbound"] },
                outcome: { type: "string", enum: ["completed", "voicemail", "missed", "fallback_retell", "failover_static"] },
                startedAt: { type: "string" },
                answeredAt: { type: "string" },
                endedAt: { type: "string" },
                durationSeconds: { type: "number" },
                answeredBy: { type: "string" },
                fallbackChain: { type: "string" },
                language: { type: "string" },
                confidence: { type: "number" },
                personId: { type: "string" }
              },
              required: ["id"]
            }
          },
          {
            name: "delete_phone_call",
            description: "Delete a PhoneCall record by ID",
            inputSchema: {
              type: "object",
              properties: { id: { type: "string", description: "PhoneCall ID to delete" } },
              required: ["id"]
            }
          }
        ]
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          // People operations
          case "create_person":
            return await this.createPerson(args);
          case "get_person":
            return await this.getPerson(args.id);
          case "update_person":
            return await this.updatePerson(args);
          case "list_people":
            return await this.listPeople(args);
          case "delete_person":
            return await this.deletePerson(args.id);

          // Company operations
          case "create_company":
            return await this.createCompany(args);
          case "get_company":
            return await this.getCompany(args.id);
          case "update_company":
            return await this.updateCompany(args);
          case "list_companies":
            return await this.listCompanies(args);
          case "delete_company":
            return await this.deleteCompany(args.id);

          // Note operations
          case "create_note":
            return await this.createNote(args);
          case "get_note":
            return await this.getNote(args.id);
          case "list_notes":
            return await this.listNotes(args);
          case "update_note":
            return await this.updateNote(args);
          case "delete_note":
            return await this.deleteNote(args.id);
          case "create_note_target":
            return await this.createNoteTarget(args);

          // Task operations
          case "create_task":
            return await this.createTask(args);
          case "get_task":
            return await this.getTask(args.id);
          case "list_tasks":
            return await this.listTasks(args);
          case "update_task":
            return await this.updateTask(args);
          case "delete_task":
            return await this.deleteTask(args.id);
          case "create_task_target":
            return await this.createTaskTarget(args);

          // Metadata operations
          case "get_metadata_objects":
            return await this.getMetadataObjects();
          case "get_object_metadata":
            return await this.getObjectMetadata(args.objectName);

          // Search operations
          case "search_records":
            return await this.searchRecords(args);

          // PhoneCall operations (OCP fork — custom object)
          case "create_phone_call":
            return await this.createPhoneCall(args);
          case "get_phone_call":
            return await this.getPhoneCall(args.id);
          case "list_phone_calls":
            return await this.listPhoneCalls(args);
          case "find_phone_call_by_call_sid":
            return await this.findPhoneCallByCallSid(args.twilioCallSid);
          case "update_phone_call":
            return await this.updatePhoneCall(args);
          case "delete_phone_call":
            return await this.deletePhoneCall(args.id);

          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`
            }
          ]
        };
      }
    });
  }

  // People methods
  // Translate the flat tool params to Twenty's actual REST shape:
  //   - `phone` (string or composite) → `phones` (composite object)
  //   - `companyId` → `companyId` (kept as-is; REST accepts this for linking)
  _personPayload(data) {
    const { phone, ...rest } = data;
    const payload = { ...rest };
    const normalized = normalizePhone(phone, this.defaultCountryCode);
    if (normalized !== undefined) {
      payload.phones = normalized;
    }
    return payload;
  }

  async createPerson(data) {
    const result = await this.makeRequest("/rest/people", "POST", this._personPayload(data));
    return {
      content: [
        {
          type: "text",
          text: `Created person: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getPerson(id) {
    const result = await this.makeRequest(`/rest/people/${id}`);
    return {
      content: [
        {
          type: "text",
          text: `Person details: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async updatePerson(data) {
    const { id, ...updateData } = data;
    const payload = this._personPayload(updateData);
    const result = await this.makeRequest(`/rest/people/${id}`, "PUT", payload);
    return {
      content: [
        {
          type: "text",
          text: `Updated person: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async listPeople(params = {}) {
    const { limit = 20, offset = 0, search, companyId } = params;
    let endpoint = `/rest/people?limit=${limit}&offset=${offset}`;
    
    if (search) {
      endpoint += `&search=${encodeURIComponent(search)}`;
    }
    if (companyId) {
      endpoint += `&companyId=${companyId}`;
    }

    const result = await this.makeRequest(endpoint);
    return {
      content: [
        {
          type: "text",
          text: `People list: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async deletePerson(id) {
    await this.makeRequest(`/rest/people/${id}`, "DELETE");
    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted person with ID: ${id}`
        }
      ]
    };
  }

  // Company methods
  async createCompany(data) {
    const result = await this.makeRequest("/rest/companies", "POST", data);
    return {
      content: [
        {
          type: "text",
          text: `Created company: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getCompany(id) {
    const result = await this.makeRequest(`/rest/companies/${id}`);
    return {
      content: [
        {
          type: "text",
          text: `Company details: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async updateCompany(data) {
    const { id, ...updateData } = data;
    const result = await this.makeRequest(`/rest/companies/${id}`, "PUT", updateData);
    return {
      content: [
        {
          type: "text",
          text: `Updated company: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async listCompanies(params = {}) {
    const { limit = 20, offset = 0, search } = params;
    let endpoint = `/rest/companies?limit=${limit}&offset=${offset}`;
    
    if (search) {
      endpoint += `&search=${encodeURIComponent(search)}`;
    }

    const result = await this.makeRequest(endpoint);
    return {
      content: [
        {
          type: "text",
          text: `Companies list: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async deleteCompany(id) {
    await this.makeRequest(`/rest/companies/${id}`, "DELETE");
    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted company with ID: ${id}`
        }
      ]
    };
  }

  // Note methods
  // Translate the tool's flat `body` string into Twenty's actual `bodyV2: { markdown }`
  // shape. Empirically, current Twenty rejects the legacy `body` field outright with
  // "Object note doesn't have any 'body' field." — so we send bodyV2 only.
  _notePayload(data) {
    const { body, ...rest } = data;
    const payload = { ...rest };
    if (body !== undefined && body !== null) {
      payload.bodyV2 = { markdown: String(body) };
    }
    return payload;
  }

  async createNote(data) {
    const result = await this.makeRequest("/rest/notes", "POST", this._notePayload(data));
    return {
      content: [
        {
          type: "text",
          text: `Created note: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getNote(id) {
    const result = await this.makeRequest(`/rest/notes/${id}`);
    return {
      content: [
        {
          type: "text",
          text: `Note details: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async listNotes(params = {}) {
    const { limit = 20, offset = 0, search } = params;
    let endpoint = `/rest/notes?limit=${limit}&offset=${offset}`;
    
    if (search) {
      endpoint += `&search=${encodeURIComponent(search)}`;
    }

    const result = await this.makeRequest(endpoint);
    return {
      content: [
        {
          type: "text",
          text: `Notes list: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async updateNote(data) {
    const { id, ...updateData } = data;
    const result = await this.makeRequest(`/rest/notes/${id}`, "PUT", this._notePayload(updateData));
    return {
      content: [
        {
          type: "text",
          text: `Updated note: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async createNoteTarget(data) {
    const { noteId, personId } = data;
    // Twenty's NoteTarget join object can use either `personId` or `targetPersonId`
    // depending on version. Try the natural name first, fall back on field error.
    try {
      const result = await this.makeRequest("/rest/noteTargets", "POST", { noteId, personId });
      return {
        content: [
          { type: "text", text: `Linked Note ${noteId} to Person ${personId}: ${JSON.stringify(result, null, 2)}` }
        ]
      };
    } catch (e) {
      if (/Field|column|not defined|not exist|unknown|invalid/i.test(e.message)) {
        const result = await this.makeRequest("/rest/noteTargets", "POST", { noteId, targetPersonId: personId });
        return {
          content: [
            { type: "text", text: `Linked Note ${noteId} to Person ${personId} (via targetPersonId): ${JSON.stringify(result, null, 2)}` }
          ]
        };
      }
      throw e;
    }
  }

  async deleteNote(id) {
    await this.makeRequest(`/rest/notes/${id}`, "DELETE");
    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted note with ID: ${id}`
        }
      ]
    };
  }

  // Task methods
  async createTask(data) {
    const result = await this.makeRequest("/rest/tasks", "POST", data);
    return {
      content: [
        {
          type: "text",
          text: `Created task: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getTask(id) {
    const result = await this.makeRequest(`/rest/tasks/${id}`);
    return {
      content: [
        {
          type: "text",
          text: `Task details: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async listTasks(params = {}) {
    const { limit = 20, offset = 0, status, assigneeId } = params;
    let endpoint = `/rest/tasks?limit=${limit}&offset=${offset}`;
    
    if (status) {
      endpoint += `&status=${status}`;
    }
    if (assigneeId) {
      endpoint += `&assigneeId=${assigneeId}`;
    }

    const result = await this.makeRequest(endpoint);
    return {
      content: [
        {
          type: "text",
          text: `Tasks list: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async updateTask(data) {
    const { id, ...updateData } = data;
    const result = await this.makeRequest(`/rest/tasks/${id}`, "PUT", updateData);
    return {
      content: [
        {
          type: "text",
          text: `Updated task: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async deleteTask(id) {
    await this.makeRequest(`/rest/tasks/${id}`, "DELETE");
    return {
      content: [
        {
          type: "text",
          text: `Successfully deleted task with ID: ${id}`
        }
      ]
    };
  }

  async createTaskTarget(data) {
    const { taskId, personId } = data;
    // Same two-step join pattern as NoteTarget: try `personId`, fall back to
    // `targetPersonId` for Twenty versions that expect that field name.
    try {
      const result = await this.makeRequest("/rest/taskTargets", "POST", { taskId, personId });
      return {
        content: [
          { type: "text", text: `Linked Task ${taskId} to Person ${personId}: ${JSON.stringify(result, null, 2)}` }
        ]
      };
    } catch (e) {
      if (/Field|column|not defined|not exist|unknown|invalid/i.test(e.message)) {
        const result = await this.makeRequest("/rest/taskTargets", "POST", { taskId, targetPersonId: personId });
        return {
          content: [
            { type: "text", text: `Linked Task ${taskId} to Person ${personId} (via targetPersonId): ${JSON.stringify(result, null, 2)}` }
          ]
        };
      }
      throw e;
    }
  }

  // Metadata methods
  async getMetadataObjects() {
    const result = await this.makeRequest("/rest/metadata/objects");
    return {
      content: [
        {
          type: "text",
          text: `Metadata objects: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  async getObjectMetadata(objectName) {
    const result = await this.makeRequest(`/rest/metadata/objects/${objectName}`);
    return {
      content: [
        {
          type: "text",
          text: `Metadata for ${objectName}: ${JSON.stringify(result, null, 2)}`
        }
      ]
    };
  }

  // Search methods
  async searchRecords(params) {
    const { query, objectTypes = ['people', 'companies'], limit = 10 } = params;
    const results = {};

    for (const objectType of objectTypes) {
      try {
        const endpoint = `/rest/${objectType}?search=${encodeURIComponent(query)}&limit=${limit}`;
        results[objectType] = await this.makeRequest(endpoint);
      } catch (error) {
        results[objectType] = { error: error.message };
      }
    }

    return {
      content: [
        {
          type: "text",
          text: `Search results for "${query}": ${JSON.stringify(results, null, 2)}`
        }
      ]
    };
  }

  // PhoneCall methods (OCP fork — custom object)

  // Twenty SELECT fields expect UPPERCASE values; the tool schema uses lowercase
  // (e.g. "inbound", "voicemail"). Normalize so callers can pass either.
  _phoneCallPayload(data) {
    const out = { ...data };
    if (typeof out.direction === "string") out.direction = out.direction.toUpperCase();
    if (typeof out.outcome === "string") out.outcome = out.outcome.toUpperCase();
    return out;
  }

  // Twenty REST returns the collection under data.<objectPlural>; tolerate other shapes.
  _extractPhoneCalls(result) {
    return (
      result?.data?.phoneCalls ??
      result?.phoneCalls ??
      (Array.isArray(result?.data) ? result.data : null) ??
      []
    );
  }

  async _findRecordByCallSid(twilioCallSid) {
    if (!twilioCallSid) return null;
    const endpoint = `/rest/phoneCalls?filter=${encodeURIComponent(`twilioCallSid[eq]:${twilioCallSid}`)}&limit=1`;
    return this._extractPhoneCalls(await this.makeRequest(endpoint))[0] || null;
  }

  // Most recent PhoneCall from the same caller created within `windowMin` minutes.
  // Used to merge records when two paths (Phone2CRM pipeline vs Retell) log the same
  // call under different twilioCallSids — they share the caller's fromNumber.
  async _findRecentRecordByFromNumber(fromNumber, windowMin) {
    if (!fromNumber || !(windowMin > 0)) return null;
    const endpoint = `/rest/phoneCalls?filter=${encodeURIComponent(`fromNumber[eq]:${fromNumber}`)}&limit=20`;
    const records = this._extractPhoneCalls(await this.makeRequest(endpoint));
    const cutoff = Date.now() - windowMin * 60 * 1000;
    const ts = (r) => Date.parse(r?.createdAt || r?.created_at || 0);
    return records
      .filter((r) => Number.isFinite(ts(r)) && ts(r) >= cutoff)
      .sort((a, b) => ts(b) - ts(a))[0] || null;
  }

  // Build a non-destructive update: fill blanks, never downgrade outcome, append a
  // genuinely different transcript rather than overwrite it.
  _mergePhoneCallUpdate(existing, incoming) {
    const RANK = { COMPLETED: 5, FALLBACK_RETELL: 4, VOICEMAIL: 3, MISSED: 2, FAILOVER_STATIC: 1 };
    const update = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (v === null || v === undefined || v === "") continue;
      // Backfill the sid when the existing record lacks one (Retell wrote first);
      // never replace a different existing sid — the upsert guard prevents that
      // pairing from matching at all.
      if (k === "twilioCallSid") { if (!existing.twilioCallSid) update.twilioCallSid = v; continue; }
      if (k === "outcome" || k === "transcript") continue;
      update[k] = v;
    }
    const exOut = (existing.outcome || "").toUpperCase();
    const inOut = (incoming.outcome || "").toUpperCase();
    if (inOut) {
      const best = (RANK[inOut] || 0) >= (RANK[exOut] || 0) ? inOut : exOut;
      if (best && best !== exOut) update.outcome = best;
    }
    const exT = existing.transcript || "";
    const inT = incoming.transcript || "";
    if (inT && inT !== exT) update.transcript = exT ? `${exT}\n\n--- (merged) ---\n\n${inT}` : inT;
    return update;
  }

  // Upsert: dedup on twilioCallSid first, then on fromNumber within a recency window
  // (default 10 min, override with PHONECALL_DEDUP_WINDOW_MIN; set 0 to disable the
  // number match). Every consumer of this tool — Phone2CRM, Retell, future automations —
  // inherits the dedup, so the same call can't land in the CRM twice.
  async createPhoneCall(data) {
    const windowMin = parseInt(process.env.PHONECALL_DEDUP_WINDOW_MIN || "10", 10);
    const payload = this._phoneCallPayload(data);

    let existing = await this._findRecordByCallSid(payload.twilioCallSid);
    let matchedBy = existing ? "twilioCallSid" : null;
    if (!existing && payload.fromNumber) {
      const candidate = await this._findRecentRecordByFromNumber(payload.fromNumber, windowMin);
      // Merge-by-number exists for the SAME call logged by two writers (Phone2CRM
      // vs Retell), where at most one side knows the twilioCallSid. When BOTH
      // sides carry a sid and they differ, they are two DIFFERENT calls from the
      // same caller (e.g. rings back within the window) — never merge those.
      // Live-verified 2026-07-16: three test calls in 5 min merged into one record.
      if (candidate && !(payload.twilioCallSid && candidate.twilioCallSid && candidate.twilioCallSid !== payload.twilioCallSid)) {
        existing = candidate;
        matchedBy = `fromNumber within ${windowMin}m`;
      }
    }

    if (existing) {
      const update = this._mergePhoneCallUpdate(existing, payload);
      if (Object.keys(update).length === 0) {
        return { content: [{ type: "text", text: `PhoneCall already current (matched by ${matchedBy}, id=${existing.id}); no changes made.` }] };
      }
      const result = await this.makeRequest(`/rest/phoneCalls/${existing.id}`, "PUT", update);
      return { content: [{ type: "text", text: `Upserted PhoneCall (matched by ${matchedBy} → updated id=${existing.id}): ${JSON.stringify(result, null, 2)}` }] };
    }

    const result = await this.makeRequest("/rest/phoneCalls", "POST", payload);
    return {
      content: [
        { type: "text", text: `Created PhoneCall: ${JSON.stringify(result, null, 2)}` }
      ]
    };
  }

  async getPhoneCall(id) {
    const result = await this.makeRequest(`/rest/phoneCalls/${id}`);
    return {
      content: [
        { type: "text", text: `PhoneCall details: ${JSON.stringify(result, null, 2)}` }
      ]
    };
  }

  async listPhoneCalls(params = {}) {
    const { limit = 20, offset = 0, filter } = params;
    let endpoint = `/rest/phoneCalls?limit=${limit}&offset=${offset}`;
    if (filter) {
      endpoint += `&filter=${encodeURIComponent(filter)}`;
    }
    const result = await this.makeRequest(endpoint);
    return {
      content: [
        { type: "text", text: `PhoneCalls list: ${JSON.stringify(result, null, 2)}` }
      ]
    };
  }

  async findPhoneCallByCallSid(twilioCallSid) {
    const endpoint = `/rest/phoneCalls?filter=${encodeURIComponent(`twilioCallSid[eq]:${twilioCallSid}`)}&limit=1`;
    const result = await this.makeRequest(endpoint);
    const records = this._extractPhoneCalls(result);
    return {
      content: [
        {
          type: "text",
          text: records.length === 0
            ? `No PhoneCall found with twilioCallSid=${twilioCallSid}`
            : `Found PhoneCall: ${JSON.stringify(records[0], null, 2)}`
        }
      ]
    };
  }

  async updatePhoneCall(data) {
    const { id, ...rest } = data;
    const updateData = this._phoneCallPayload(rest);
    const result = await this.makeRequest(`/rest/phoneCalls/${id}`, "PUT", updateData);
    return {
      content: [
        { type: "text", text: `Updated PhoneCall: ${JSON.stringify(result, null, 2)}` }
      ]
    };
  }

  async deletePhoneCall(id) {
    await this.makeRequest(`/rest/phoneCalls/${id}`, "DELETE");
    return {
      content: [
        { type: "text", text: `Successfully deleted PhoneCall with ID: ${id}` }
      ]
    };
  }

  async run() {
    const mode = (process.env.MCP_TRANSPORT || "stdio").toLowerCase();
    if (mode === "http" || mode === "streamablehttp") {
      await this.runHttp();
    } else {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);
      console.error("Twenty CRM MCP server running on stdio");
    }
  }

  // Streamable HTTP transport. Stateless: every POST gets a fresh transport +
  // a fresh TwentyCRMServer instance so concurrent requests don't collide on
  // JSON-RPC IDs or share state. The MCP `Server` can only be connected once,
  // hence per-request instantiation — see the SDK README "Stateless mode".
  async runHttp() {
    const port = parseInt(process.env.MCP_HTTP_PORT || "8000", 10);
    const path = process.env.MCP_HTTP_PATH || "/mcp";
    const bearerToken = process.env.MCP_BEARER_TOKEN || "";
    if (!bearerToken) {
      console.error("WARNING: MCP_BEARER_TOKEN unset — HTTP endpoint is unauthenticated.");
    }

    const httpServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }

      if (url.pathname !== path) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      if (bearerToken && req.headers.authorization !== `Bearer ${bearerToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }

      let body;
      if (req.method === "POST") {
        try {
          const raw = await new Promise((resolve, reject) => {
            const chunks = [];
            req.on("data", (c) => chunks.push(c));
            req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            req.on("error", reject);
          });
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_json" }));
          return;
        }
      }

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const perRequestServer = new TwentyCRMServer();
      res.on("close", () => { transport.close(); });
      try {
        await perRequestServer.server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (err) {
        console.error("HTTP transport error:", err);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "internal_error", message: err.message }));
        }
      }
    });

    await new Promise((resolve) => httpServer.listen(port, "0.0.0.0", resolve));
    console.error(`Twenty CRM MCP server running on http://0.0.0.0:${port}${path}`);
  }
}

const server = new TwentyCRMServer();
server.run().catch(console.error);