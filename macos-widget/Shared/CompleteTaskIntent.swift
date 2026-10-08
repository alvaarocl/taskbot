import AppIntents
import Foundation

private let taskbotAppGroupID = "group.com.alvarocarpintero.taskbot"
private let taskbotItemsURL = taskbotBaseURL + "/api/items/"

struct CompleteTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Marcar tarea como hecha"
    static var description = IntentDescription("Marca como hecha una tarea pendiente de Taskbot.")

    @Parameter(title: "ID de tarea")
    var itemID: Int

    init() {
        itemID = 0
    }

    init(itemID: Int) {
        self.itemID = itemID
    }

    func perform() async throws -> some IntentResult {
        guard let token = UserDefaults(suiteName: taskbotAppGroupID)?.string(forKey: "dashboardToken"), !token.isEmpty else {
            throw TaskbotIntentError.missingToken
        }

        guard let url = URL(string: taskbotItemsURL + String(itemID)) else {
            throw TaskbotIntentError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "PATCH"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 15
        request.httpBody = try JSONSerialization.data(withJSONObject: ["status": "hecha"])

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw TaskbotIntentError.updateFailed
        }
        return .result()
    }
}

struct NavigateTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "Cambiar página de tareas"
    static var description = IntentDescription("Muestra las tareas pendientes siguientes o anteriores.")

    @Parameter(title: "Página")
    var page: Int

    init() {
        page = 0
    }

    init(page: Int) {
        self.page = page
    }

    func perform() async throws -> some IntentResult {
        UserDefaults(suiteName: taskbotAppGroupID)?.set(max(0, page), forKey: "widgetPage")
        return .result()
    }
}

private enum TaskbotIntentError: LocalizedError {
    case missingToken
    case invalidURL
    case updateFailed

    var errorDescription: String? {
        switch self {
        case .missingToken: return "Abre Taskbot y guarda tu clave para usar el widget."
        case .invalidURL: return "No se pudo preparar la actualización de la tarea."
        case .updateFailed: return "No se pudo marcar la tarea como hecha. Comprueba la conexión y vuelve a intentarlo."
        }
    }
}
