import "./App.css";
import { WidgetPanel } from "./widgets/host/WidgetPanel";
import { MenuBar } from "./components/MenuBar";
import { NotebooksPanel } from "./components/NotebooksPanel";
import { useLang } from "./i18n";
import { useDialogController } from "./dialog/useDialogController";
import { DialogView } from "./dialog/DialogView";

// ---------------------------------------------------------------------------
// App — тонкая оболочка (шаг 4 расщепления). Только сборка каркаса:
//   MenuBar | (NotebooksPanel + DialogView + WidgetPanel).
// Вся логика/состояние диалога — в useDialogController; вся вёрстка центральной
// области — в DialogView. Менять дизайн окна диалога нужно в DialogView (+ CSS),
// не трогая этот файл и контроллер.
//
// useLang() здесь: перерисовка всего поддерева при смене языка (t() в DialogView
// пересчитается, т.к. App — его родитель).
// ---------------------------------------------------------------------------

function App() {
  useLang();
  const c = useDialogController();

  return (
    <div className="app-root">
      <MenuBar />
      <div className="app-shell">
        <NotebooksPanel
          notebooks={c.notebooks}
          dialogs={c.dialogs}
          activeDialogId={c.dialogId}
          onOpenDialog={c.openDialog}
          reloadTree={c.reloadTree}
          patchDialogTitle={c.patchDialogTitle}
        />
        <DialogView c={c} />
        <WidgetPanel
          facts={c.facts}
          capabilityDeps={c.capabilityDeps}
          llmSelection={c.llmSelection}
        />
      </div>
    </div>
  );
}

export default App;
