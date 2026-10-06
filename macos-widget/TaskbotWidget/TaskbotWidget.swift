import SwiftUI
import WidgetKit

private let apiURL = URL(string: "https://taskbot.YOUR-SUBDOMAIN.workers.dev/api/items?status=pendiente&kind=tarea")!
private let dashboardURL = URL(string: "https://taskbot.YOUR-SUBDOMAIN.workers.dev")!
private let appGroupID = "group.com.alvarocarpintero.taskbot"

struct TodoItem: Decodable, Identifiable {
    let id: Int
    let text: String
    let priority: String?
    let due_date: String?
}

private struct ItemsResponse: Decodable {
    let items: [TodoItem]
}

struct TaskEntry: TimelineEntry {
    let date: Date
    let tasks: [TodoItem]
    let error: Bool
    let page: Int
}

struct TaskProvider: TimelineProvider {
    func placeholder(in context: Context) -> TaskEntry {
        TaskEntry(date: .now, tasks: [TodoItem(id: 1, text: "Preparar la semana", priority: "urgente", due_date: nil)], error: false, page: 0)
    }

    func getSnapshot(in context: Context, completion: @escaping (TaskEntry) -> Void) {
        Task { completion(await load()) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<TaskEntry>) -> Void) {
        Task {
            let entry = await load()
            completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(15 * 60))))
        }
    }

    private func load() async -> TaskEntry {
        guard let token = UserDefaults(suiteName: appGroupID)?.string(forKey: "dashboardToken"), !token.isEmpty else {
            return TaskEntry(date: .now, tasks: [], error: true, page: 0)
        }
        do {
            var request = URLRequest(url: apiURL)
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            request.timeoutInterval = 10
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                return TaskEntry(date: .now, tasks: [], error: true, page: 0)
            }
            let decoded = try JSONDecoder().decode(ItemsResponse.self, from: data)
            let defaults = UserDefaults(suiteName: appGroupID)
            let page = max(0, defaults?.integer(forKey: "widgetPage") ?? 0)
            return TaskEntry(date: .now, tasks: decoded.items, error: false, page: page)
        } catch {
            return TaskEntry(date: .now, tasks: [], error: true, page: 0)
        }
    }
}

struct TaskbotWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: TaskEntry

    private var limit: Int {
        switch family {
        case .systemSmall: return 2
        case .systemLarge: return 8
        default: return 3
        }
    }

    private var pageCount: Int {
        max(1, (entry.tasks.count + limit - 1) / limit)
    }

    private var currentPage: Int {
        min(entry.page, pageCount - 1)
    }

    private var visibleTasks: [TodoItem] {
        let start = currentPage * limit
        return Array(entry.tasks.dropFirst(start).prefix(limit))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(visibleTasks) { task in
                HStack(alignment: .center, spacing: 7) {
                    Button(intent: CompleteTaskIntent(itemID: task.id)) {
                        Image(systemName: "checkmark.circle")
                            .font(.system(size: 19, weight: .regular))
                            .foregroundStyle(.green)
                            .frame(width: 23, height: 23)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Marcar \(task.text) como hecha")
                    Text(task.text)
                        .font(.system(size: 14, weight: .medium))
                        .lineLimit(family == .systemSmall ? 2 : 1)
                        .truncationMode(.tail)
                    Spacer(minLength: 0)
                }
            }
            if pageCount > 1 {
                HStack {
                    if currentPage > 0 {
                        Button(intent: NavigateTasksIntent(page: currentPage - 1)) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 13, weight: .semibold))
                                .frame(width: 23, height: 23)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Tareas anteriores")
                    }
                    Spacer(minLength: 0)
                    if currentPage + 1 < pageCount {
                        Button(intent: NavigateTasksIntent(page: currentPage + 1)) {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 13, weight: .semibold))
                                .frame(width: 23, height: 23)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Tareas siguientes")
                    }
                }
            }
        }
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .padding(10)
        .containerBackground(.background, for: .widget)
        .widgetURL(dashboardURL)
    }
}

@main
struct TaskbotWidget: Widget {
    let kind = "TaskbotWidget"
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: TaskProvider()) { entry in
            TaskbotWidgetView(entry: entry)
        }
        .configurationDisplayName("Tareas pendientes")
        .description("Consulta tus próximas tareas pendientes de Taskbot.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
