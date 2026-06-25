// src/dialog/types.ts
// Типы данных основного диалога. Вынесены из App.tsx (шаг 1 расщепления
// контроллер<->презентация): и контроллер (useDialogController), и будущий
// презентационный слой (DialogView) импортируют формы отсюда, а не из App.

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Message {
  role: "user" | "assistant";
  content: string;
  nodeId: string;
  nodeType: string;             // user_message | assistant_message | unanswered_placeholder
  childrenCount: number;         // total, включая удалённые
  deletedChildrenCount: number;  // только удалённые (D-050)
  markers: MarkerData[];         // маркеры на этом узле (D-058)
}

export interface MarkerData {
  id: string;
  nodeId: string;
  label: string;
  comment: string | null;
}

// Данные A0-анкора корня (D-090) для хедера действий над лентой: корневой
// маркер #0, счётчики веток/удалённых. Сам A0 в ленту не идёт (скрыт по
// node_type), но его действия (⚑#0 / + / ⑂) живут в шапке беседы.
export interface RootActions {
  nodeId: string;
  childrenCount: number;
  deletedChildrenCount: number;
  markers: MarkerData[];
}

export interface DbDialog {
  id: string;
  title: string;
  notebook_id: string | null;
  root_node_id: string | null;
  active_leaf_id: string | null;
}

export interface DbNode {
  id: string;
  parent_id: string | null;
  dialog_id: string;
  node_type: string;
  content: string;
  active_child_id: string | null;
  children_count: number;
  branch_name: string | null;
  last_visited_leaf_id: string | null;
  is_deleted: boolean;
}

export interface Notebook {
  id: string;
  parent_notebook_id: string | null;
  name: string;
  kind: string;
}

export interface SendResult {
  query_id: string;
  placeholder_id: string;
}

export interface BranchCard {
  nodeId: string;
  branchName: string;
  isActive: boolean;
}
