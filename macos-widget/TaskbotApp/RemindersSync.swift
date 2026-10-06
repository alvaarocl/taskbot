import EventKit
import Foundation

// Recordatorios ↔ taskbot, en las dos direcciones, en la lista "Taskbot":
// - cada tarea pendiente de taskbot es un recordatorio (con su fecha límite y prioridad)
// - marcar un recordatorio como completado → la tarea se marca hecha en taskbot
// - un recordatorio nuevo escrito a mano en la lista → se crea la tarea en taskbot
// - una tarea hecha o borrada en taskbot (Telegram, dashboard) → su recordatorio desaparece
// Cada recordatorio guarda el id de su tarea en la URL: taskbot://item/<id>.

struct TaskbotTask: Decodable {
    let id: Int
    let text: String
    let priority: String?
    let due_date: String?
    let due_at: String?
    let start_at: String?
    let category: String?
    let url: String?
}

@MainActor
final class RemindersSync {
    static let shared = RemindersSync()

    private let store = EKEventStore()
    private let listName = "Taskbot"
    private let scheme = "taskbot://item/"
    private let api = URL(string: "https://taskbot.YOUR-SUBDOMAIN.workers.dev/api/items")!

    /// Devuelve un resumen corto de lo que ha hecho, para la ventana de la app.
    func sync(tasks: [TaskbotTask], token: String) async throws -> String {
        guard try await store.requestFullAccessToReminders() else { throw RemindersError.denied }
        let list = try ensureList()
        let reminders = await fetch(list)

        var linked: [Int: EKReminder] = [:]
        var handwritten: [EKReminder] = []
        for r in reminders {
            if let id = itemId(r) {
                if linked[id] == nil { linked[id] = r } else { try store.remove(r, commit: false) } // duplicado
            } else if !r.isCompleted {
                handwritten.append(r)
            }
        }
        let pending = Dictionary(uniqueKeysWithValues: tasks.map { ($0.id, $0) })
        var done = 0, created = 0, imported = 0

        // 1. Completado en Recordatorios y aún pendiente en taskbot → hecha.
        for (id, r) in linked where r.isCompleted && pending[id] != nil {
            try await patch(id, ["status": "hecha"], token: token)
            done += 1
        }

        // 2. Pendientes de taskbot → crear o actualizar su recordatorio.
        for t in tasks {
            if let r = linked[t.id] {
                if r.isCompleted { continue }
                if apply(t, to: r) { try store.save(r, commit: false) }
            } else {
                let r = EKReminder(eventStore: store)
                r.calendar = list
                r.url = URL(string: "\(scheme)\(t.id)")
                _ = apply(t, to: r)
                try store.save(r, commit: false)
                created += 1
            }
        }

        // 3. Ya no está pendiente en taskbot (hecha o borrada allí) → fuera de la lista.
        for (id, r) in linked where pending[id] == nil && !r.isCompleted {
            try store.remove(r, commit: false)
        }

        // 4. Escritos a mano en la lista → tarea nueva en taskbot.
        for r in handwritten {
            let title = (r.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { continue }
            var body: [String: Any] = ["text": title, "kind": "tarea",
                                       "priority": r.priority == 1 ? "urgente" : "normal"]
            if let d = r.dueDateComponents, let y = d.year, let m = d.month, let day = d.day {
                body["due_date"] = String(format: "%04d-%02d-%02d", y, m, day)
            }
            let id = try await create(body, token: token)
            r.url = URL(string: "\(scheme)\(id)")
            try store.save(r, commit: false)
            imported += 1
        }

        try store.commit()
        var parts: [String] = []
        if done > 0 { parts.append("\(done) hecha\(done == 1 ? "" : "s")") }
        if created > 0 { parts.append("\(created) nueva\(created == 1 ? "" : "s")") }
        if imported > 0 { parts.append("\(imported) desde Recordatorios") }
        return parts.isEmpty ? "Recordatorios al día" : "Recordatorios: " + parts.joined(separator: ", ")
    }

    // MARK: - Recordatorios

    private func ensureList() throws -> EKCalendar {
        if let list = store.calendars(for: .reminder).first(where: { $0.title == listName }) { return list }
        let list = EKCalendar(for: .reminder, eventStore: store)
        list.title = listName
        // Misma cuenta que la lista por defecto (iCloud) para que salga en el iPhone.
        guard let source = store.defaultCalendarForNewReminders()?.source
            ?? store.sources.first(where: { $0.sourceType == .calDAV })
            ?? store.sources.first(where: { $0.sourceType == .local }) else { throw RemindersError.noAccount }
        list.source = source
        list.cgColor = CGColor(red: 0.20, green: 0.47, blue: 0.96, alpha: 1)
        try store.saveCalendar(list, commit: true)
        return list
    }

    private func fetch(_ list: EKCalendar) async -> [EKReminder] {
        let predicate = store.predicateForReminders(in: [list])
        return await withCheckedContinuation { cont in
            store.fetchReminders(matching: predicate) { cont.resume(returning: $0 ?? []) }
        }
    }

    private func itemId(_ r: EKReminder) -> Int? {
        guard let url = r.url?.absoluteString, url.hasPrefix(scheme) else { return nil }
        return Int(url.dropFirst(scheme.count))
    }

    /// Copia título, fecha límite, prioridad y notas. Devuelve si ha cambiado algo.
    private func apply(_ t: TaskbotTask, to r: EKReminder) -> Bool {
        var changed = false
        if r.title != t.text { r.title = t.text; changed = true }

        let priority = t.priority == "urgente" ? 1 : t.priority == "algun_dia" ? 9 : 0
        if r.priority != priority { r.priority = priority; changed = true }

        let due = dueComponents(t)
        if r.dueDateComponents != due { r.dueDateComponents = due; changed = true }

        var notes: [String] = []
        if let s = t.start_at, s.count >= 16 { notes.append("🧠 Hueco reservado: \(s.prefix(10)) \(s.dropFirst(11).prefix(5))") }
        if let c = t.category, !c.isEmpty { notes.append("🏷 \(c)") }
        if let u = t.url, !u.isEmpty { notes.append(u) }
        let text = notes.isEmpty ? nil : notes.joined(separator: "\n")
        if r.notes != text { r.notes = text; changed = true }
        return changed
    }

    private func dueComponents(_ t: TaskbotTask) -> DateComponents? {
        guard let d = t.due_date, d.count == 10 else { return nil }
        let p = d.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return nil }
        var c = DateComponents(calendar: Calendar(identifier: .gregorian), timeZone: TimeZone(identifier: "Europe/Madrid"),
                               year: p[0], month: p[1], day: p[2])
        if let at = t.due_at, at.count >= 16 {
            c.hour = Int(at.dropFirst(11).prefix(2))
            c.minute = Int(at.dropFirst(14).prefix(2))
        }
        return c
    }

    // MARK: - API de taskbot

    private func patch(_ id: Int, _ body: [String: Any], token: String) async throws {
        var req = URLRequest(url: api.appendingPathComponent(String(id)))
        req.httpMethod = "PATCH"
        try await send(&req, body, token: token)
    }

    private func create(_ body: [String: Any], token: String) async throws -> Int {
        var req = URLRequest(url: api)
        req.httpMethod = "POST"
        let data = try await send(&req, body, token: token)
        struct Created: Decodable { struct Item: Decodable { let id: Int }; let item: Item }
        return try JSONDecoder().decode(Created.self, from: data).item.id
    }

    @discardableResult
    private func send(_ req: inout URLRequest, _ body: [String: Any], token: String) async throws -> Data {
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let code = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(code) else { throw RemindersError.api }
        return data
    }
}

enum RemindersError: LocalizedError {
    case denied, noAccount, api
    var errorDescription: String? {
        switch self {
        case .denied: return "Sin permiso para Recordatorios. Actívalo en Ajustes del Sistema → Privacidad → Recordatorios."
        case .noAccount: return "No encuentro ninguna cuenta de Recordatorios (iCloud)."
        case .api: return "Taskbot no aceptó el cambio. Revisa la clave."
        }
    }
}
