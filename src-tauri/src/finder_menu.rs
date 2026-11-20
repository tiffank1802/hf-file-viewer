use tauri::{menu::{Menu, MenuBuilder, MenuItemBuilder, Submenu, SubmenuBuilder}, AppHandle, Wry};

fn submenu(app: &AppHandle, label: &str, items: &[(&str, &str, Option<&str>)]) -> tauri::Result<Submenu<Wry>> {
    let mut menu = SubmenuBuilder::new(app, label);
    for &(id, title, shortcut) in items {
        if id.is_empty() {
            menu = menu.separator();
            continue;
        }
        let mut item = MenuItemBuilder::with_id(id, title);
        if let Some(keys) = shortcut {
            item = item.accelerator(keys);
        }
        menu = menu.item(&item.build(app)?);
    }
    menu.build()
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = SubmenuBuilder::new(app, "ENISE Docs")
        .about_with_text("À propos d’ENISE Docs", None)
        .separator()
        .text("enise:update", "Rechercher les mises à jour…")
        .separator()
        .hide_with_text("Masquer ENISE Docs")
        .hide_others_with_text("Masquer les autres")
        .separator()
        .quit_with_text("Quitter ENISE Docs")
        .build()?;
    let file = submenu(app, "Fichier", &[
        ("enise:new-tab", "Nouvel onglet", Some("CmdOrCtrl+T")),
        ("enise:close-tab", "Fermer l’onglet", Some("CmdOrCtrl+W")),
        ("", "", None),
        ("enise:open", "Ouvrir la sélection", Some("CmdOrCtrl+O")),
        ("enise:info", "Lire les informations", Some("CmdOrCtrl+I")),
        ("enise:entry-actions", "Actions de la sélection…", None),
    ])?;
    let edit = SubmenuBuilder::new(app, "Édition")
        .undo_with_text("Annuler").redo_with_text("Rétablir").separator()
        .cut_with_text("Couper").copy_with_text("Copier").paste_with_text("Coller")
        .select_all_with_text("Tout sélectionner").separator()
        .text("enise:search", "Rechercher dans la bibliothèque…").build()?;
    let view = submenu(app, "Présentation", &[
        ("enise:view-grid", "Par icônes", Some("CmdOrCtrl+1")),
        ("enise:view-list", "Par liste", Some("CmdOrCtrl+2")),
        ("enise:view-columns", "Par colonnes", Some("CmdOrCtrl+3")),
        ("enise:view-gallery", "Par galerie", Some("CmdOrCtrl+4")),
        ("", "", None),
        ("enise:preview", "Afficher / masquer la prévisualisation", None),
        ("enise:sidebar", "Afficher / masquer la barre latérale", None),
        ("enise:view-options", "Options de présentation…", Some("CmdOrCtrl+J")),
    ])?;
    let go = submenu(app, "Aller", &[
        ("enise:root", "Bibliothèque", None),
        ("enise:parent", "Dossier parent", None),
        ("enise:back", "Précédent", None),
        ("enise:forward", "Suivant", None),
        ("enise:refresh", "Actualiser le dossier", Some("CmdOrCtrl+R")),
    ])?;
    let window = SubmenuBuilder::new(app, "Fenêtre").minimize_with_text("Réduire").build()?;
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &go, &window]).build()
}
