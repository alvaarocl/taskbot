import SwiftUI
import ServiceManagement
import AppKit

@main
struct TaskbotApp: App {
    @StateObject private var syncer = NotesSyncController.shared

    init() {
        NSApplication.shared.setActivationPolicy(.regular)
        Task { @MainActor in await NotesSyncController.shared.start() }
    }

    var body: some Scene {
        WindowGroup("Taskbot") {
            SettingsView(syncer: syncer)
                .task { await syncer.start() }
        }
        .defaultSize(width: 500, height: 430)
    }
}

private struct SettingsView: View {
    @ObservedObject var syncer: NotesSyncController
    @AppStorage("dashboardToken", store: SharedSettings.defaults) private var token = ""
    @State private var saved = false
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Taskbot — Notas", systemImage: "checklist")
                .font(.largeTitle.bold())
            Text("Taskbot copiará a Apple Notes todas las tareas pendientes que captures en Telegram.")
                .foregroundStyle(.secondary)
            SecureField("Clave DASH_TOKEN", text: $token)
                .textFieldStyle(.roundedBorder)
                .onChange(of: token) { _, _ in saved = false }
            HStack {
                Button("Guardar clave") {
                    SharedSettings.defaults?.set(token.trimmingCharacters(in: .whitespacesAndNewlines), forKey: "dashboardToken")
                    token = token.trimmingCharacters(in: .whitespacesAndNewlines)
                    saved = true
                    Task { await syncer.syncNow() }
                }
                .disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if saved { Label("Guardada", systemImage: "checkmark.circle.fill").foregroundStyle(.green) }
            }
            Toggle("Iniciar Taskbot al iniciar sesión", isOn: $launchAtLogin)
                .onChange(of: launchAtLogin) { _, enabled in
                    do {
                        if enabled { try SMAppService.mainApp.register() }
                        else { try SMAppService.mainApp.unregister() }
                        SharedSettings.defaults?.set(true, forKey: "didConfigureLoginItem")
                    } catch {
                        syncer.status = "No se pudo cambiar el inicio automático: \(error.localizedDescription)"
                        launchAtLogin = SMAppService.mainApp.status == .enabled
                    }
                }
            Text("Taskbot se queda en la barra de menús y actualiza la nota cada 5 minutos. La primera vez, macOS te pedirá permiso para controlar Notas.")
                .font(.callout)
                .foregroundStyle(.secondary)
            HStack {
                Button("Sincronizar ahora") { Task { await syncer.syncNow() } }
                    .disabled(syncer.isSyncing || token.isEmpty)
                Text(syncer.status).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(24)
        .frame(width: 500)
        .onAppear { NSApplication.shared.activate(ignoringOtherApps: true) }
    }
}
