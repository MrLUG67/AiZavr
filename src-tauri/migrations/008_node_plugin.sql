-- Migration 008: plugin (LLM provider) that produced a node.
-- Раньше хранили только model_id; плагин в строке метрики брался из активного
-- провайдера, что неверно для исторических ответов. Теперь фиксируем плагин
-- по каждому ответу. NULL у старых узлов и у Q/заглушек.

ALTER TABLE nodes ADD COLUMN plugin_id TEXT; -- which LLM plugin generated this node
