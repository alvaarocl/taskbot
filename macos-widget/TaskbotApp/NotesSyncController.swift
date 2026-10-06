import AppKit
import Combine
import Foundation
import ServiceManagement
import WidgetKit

private let taskbotNotesAPI = URL(string: "https://taskbot.YOUR-SUBDOMAIN.workers.dev/api/items?status=pendiente&kind=tarea")!
private let notesTitle = "Taskbot — Tareas pendientes"

struct NotesTask: Decodable {
    let id: Int
    let text: String
    let priority: String?
    let due_date: String?
    let category: String?
}

private struct NotesItemsResponse: Decodable {
    let items: [NotesTask]
}

@MainActor
final class NotesSyncController: ObservableObject {
    static let shared = NotesSyncController()

    @Published var status = "Esperando configuración"
    @Published private(set) var isSyncing = false
    private var timerTask: Task<Void, Never>?

    func start() async {
        guard timerTask == nil else { return }
        let defaults = SharedSettings.defaults
        if defaults?.bool(forKey: "didConfigureLoginItem") != true {
            do {
                if SMAppService.mainApp.status != .enabled { try SMAppService.mainApp.register() }
                defaults?.set(true, forKey: "didConfigureLoginItem")
            } catch {
                status = "Activa Taskbot al iniciar sesión en Configuración del Sistema para sincronizar siempre"
            }
        }
        await syncNow()
        timerTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(300))
                guard !Task.isCancelled else { return }
                await self?.syncNow()
            }
        }
    }

    func syncNow() async {
        guard !isSyncing else { return }
        guard let token = SharedSettings.defaults?.string(forKey: "dashboardToken"), !token.isEmpty else {
            status = "Guarda tu DASH_TOKEN para activar la sincronización"
            return
        }

        isSyncing = true
        defer { isSyncing = false }
        do {
            var request = URLRequest(url: taskbotNotesAPI)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 20
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                throw SyncError.api
            }
            let items = try JSONDecoder().decode(NotesItemsResponse.self, from: data).items
            try writeNote(items)
            WidgetCenter.shared.reloadAllTimelines()
            let count = items.count
            let time = Date.now.formatted(date: .omitted, time: .shortened)
            status = "Notas actualizada · \(count) \(count == 1 ? "tarea" : "tareas") · \(time)"
        } catch {
            status = "Error al sincronizar: \(error.localizedDescription)"
        }
    }

    private func writeNote(_ items: [NotesTask]) throws {
        let date = Date.now.formatted(date: .abbreviated, time: .shortened)
        var lines = ["Taskbot · \(items.count) tareas pendientes", "Actualizada: \(date)", ""]
        for item in items {
            let marker = item.priority == "urgente" ? "🔥" : item.priority == "algun_dia" ? "🌙" : "☐"
            var details: [String] = []
            if let due = item.due_date, !due.isEmpty { details.append("📅 \(due)") }
            if let category = item.category, !category.isEmpty { details.append("🏷 \(category)") }
            let suffix = details.isEmpty ? "" : " — " + details.joined(separator: " · ")
            lines.append("\(marker) \(item.text)\(suffix)")
        }
        if items.isEmpty { lines.append("🎉 No tienes tareas pendientes.") }
        let htmlLines = lines.map(escapeHTML).joined(separator: "<br>")
        let html = "<html><body>\(htmlLines)</body></html>"
        let script = """
        tell application id "com.apple.Notes" to launch
        tell application id "com.apple.Notes"
            set targetTitle to "\(escapeAppleScript(notesTitle))"
            set noteBody to "\(escapeAppleScript(html))"
            if exists (first note whose name is targetTitle) then
                set body of (first note whose name is targetTitle) to noteBody
            else
                make new note at folder 1 with properties {name:targetTitle, body:noteBody}
            end if
        end tell
        """
        guard let appleScript = NSAppleScript(source: script) else { throw SyncError.notes }
        var errorInfo: NSDictionary?
        appleScript.executeAndReturnError(&errorInfo)
        if let errorInfo { throw SyncError.notesDetails(errorInfo[NSAppleScript.errorMessage] as? String ?? "Permiso denegado") }
    }

    private func escapeAppleScript(_ value: String) -> String {
        value.replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\\n")
            .replacingOccurrences(of: "\r", with: "")
    }

    private func escapeHTML(_ value: String) -> String {
        value.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
    }
}

private enum SyncError: LocalizedError {
    case api
    case notes
    case notesDetails(String)

    var errorDescription: String? {
        switch self {
        case .api: return "Taskbot no pudo consultar las tareas. Revisa la clave y la conexión."
        case .notes: return "No se pudo actualizar Apple Notes."
        case .notesDetails(let message): return "Apple Notes: \(message). Revisa Permisos de automatización en Ajustes del Sistema."
        }
    }
}
