# 0029. 复数的 provider 词可以是资源；与资源同名的叶子工具在浏览和 did you mean 里被找到

- 状态：已接受
- 日期：2026-10-26

## 背景

用一个名为 `todos` 的 HTTP server 评估 via 0.3.1 时，同一个对象被拆成了两半，而且读工具找不到：

- 规则 2 去掉与 provider 名相同的词。`close_todos`、`complete_todos`、`reopen_todos` 去掉 `todos` 之后只剩一个动词。`stripProviderWords` 只保证「不剥光」，不保证剩下的词里还有资源词，于是这三个成了叶子 `close`、`complete`、`reopen`。`create_todo` 的 `todo` 与 `todos` 不相等，不受影响，是 `todo:create`。
- `set_secret`、`confirm_builds`、`complete_todos`、`reopen_todos` 里的 `set`、`confirm`、`complete`、`reopen` 不在动词表里，所以是叶子；同组的 `delete_secrets`、`run_builds` 是 `secret:delete`、`build:run`。
- 列出对象的工具是叶子 `todos`、`secrets`、`builds`（没有动词，不在任何资源下）。`via todos secret` 只显示 `secret:delete`，看不到 `secrets`。
- `via todos todo:list` 回答 `did you mean: todos todo:create · todos todo:update`，`via todos secret:list` 回答 `todos secret:delete`，`via todos list-todos` 回答 `todos close-todos`。候选只按编辑距离排序，读工具（叶子）不在其中；候选里只剩写操作，agent 照着做就改了数据。

## 决策

1. **复数的 provider 词在结尾时可以是资源**（[naming.md](../spec/naming.md) 规则 2）。去掉 provider 词之后，如果剩下的只有动词（链）、没有资源词，并且去掉的词里有位于结尾的、末词是复数形式的，就保留这些词作为资源（单数化）：`close_todos` 在 `todos` 下是 `todo:close`。条件的每一项都有理由：

   - **没有资源词**：已经有资源词时（`list_todo_items`）不需要补，provider 词照常去掉。
   - **在结尾**：`close todos` 里 provider 词是动词的宾语。开头的 provider 词是命名空间（`todos_close`、`notion-search`、`acme_search`），规则 7 与示例依赖它们是叶子 `search`，不变。
   - **复数**：宾语位置的单数 provider 词多半是品牌名（`search_exa`、`run_sqlite`），不是在说一类对象；`exa:search` 没有意义。复数形式（`todos`、`docs`、`issues`）是一个名词，说的是一个集合。判断用已有的单数化函数（词变了就是复数），确定、不查词典。
   
   两个已知的边缘：以 `s` 结尾的品牌名会被单数化规则当成复数（`postgres` → `postgre`），所以 `query_postgres` 会得到 `postgre:query`；发现这种名字时把它加进 `singularExceptions`（那里已有 `aws`、`gas`、`ios`）。已经有 `资源:动作` 冲突时仍按规则 6 退回叶子，叶子名是去掉 provider 词之后的名字（`close`），这与以前一致。

2. **provider 词的比较仍是精确相等，不做单数化。** 考虑过把 `todos` 与 `todo` 视为同一个词：`create_todo` 会被剥成只有动词，再由决策 1 的例外补回 `todo`，结果仍是 `todo:create`；但「单数」在决策 1 里已经不满足复数条件，补不回，`create_todo` 就会变成叶子 `create`，比现在更糟。同时 `list_todo_items` 也会被改成 `item:list`，丢掉 `todo` 这个限定词。精确相等保持了现有的结果：`create_todo` 与 `list_todo_items` 的规范写法不变，只有「剥完只剩动词」的名字变了。

3. **动词表加 `set`、`confirm`、`complete`、`reopen`**，另加同类的 `assign`、`unassign`、`approve`、`reject`（`data/verbs.json` 版本 2 → 3）。依据是 `npm run split-diff`：在 `test/fixtures/tools` 与 `other` 全部样本上，这八个词只让三个原来的叶子变成 `资源:动作`，没有改变任何已有的 `资源:动作`（见后果）。试过的其他词没有收：`reply` 会把 `reply_to_thread` 错拆成 `to-thread:reply`；`open`、`share`、`start`、`stop` 在样本上拆得对，但都是常用名词，没有足够样本时不收；其余（`archive`、`pause`、`resume`、`retry`、`revoke`、`rename`、`publish`、`deploy`…）在样本里没有出现，没有证据，不加。名动兼类的词按[数据文件](../development/data-files.md#verbsjson)的原则谨慎。

4. **资源视图提示同名的叶子**（[discovery.md](../spec/discovery.md#via-provider-resource)）。单数化（逐词）之后名字等于资源名的叶子工具，作为一行排在资源自己的工具之后，带签名和描述；`-o json` 里是同一个数组末尾的条目，`resource` 与 `verb` 为 `null`。选择「一行」是因为读工具要的就是签名，一行等于省掉一次 `-h`；选择「数组末尾的条目」是因为这个数组的形状不变（已有的使用者按 `ref` 取字段不受影响），而叶子的 `resource`、`verb` 为 `null` 早已是 `via find` 里的约定。
   叶子被规则 7 挤到原始名时（`acme-search` 之于资源 `search`），按拆分时的叶子名比较，显示现在的名字。

5. **did you mean 把同名叶子放在前面**（[discovery.md](../spec/discovery.md#找不到时)）。资源与动作找不到时，候选按这个顺序取前 3 个：资源下只差一个笔误的动作，同名的叶子，没有笔误时资源下的其他动作（标了 `destructiveHint` 的在最后），最后才是资源不存在时按段编辑距离近的名字。`list-todos` 这样的写法按拆分规则解析成 `todo:list` 再走同一条路径；输入的资源词先单数化（`secrets:list` 等于 `secret:list`）。`next:` 指向第一个候选，这是已有的行为。笔误排在叶子之前，是因为笔误几乎肯定是写错了那个动作；没有笔误时输入的动作（`list`、`get`）在资源里不存在，最可能的意思就是「读这类对象」，那个工具就是同名的叶子。
   不用 `readOnlyHint` 排序读工具：todos 没有任何注解，而且靠名字猜读写要一张动词的读写表，规则类内容要放进 `data/` 并长期维护。标了 `destructiveHint` 的排最后，是唯一用到注解的地方。

## 备选方案

- **把叶子并进资源**（`todos` 自动成为 `todo:list`）：违反「叶子与资源同名」时的现有约定，并且要为它选一个动词，没有依据。
- **不管单复数，剥完只剩动词就一律保留 provider 词**：`search_exa` 变成 `exa:search`。
- **在 did you mean 里加读写动词表**：见决策 5。
- **资源视图只在文字里提示名字，不带签名**：读工具要再来一次 `-h`。

## 后果

- 规范写法会变的名字（`split-diff` 在 `test/fixtures` 全部样本上的结果）：`notion-set-comment-reaction` 从叶子 `set-comment-reaction` 变为 `comment-reaction:set`，`notion-set-discussion-resolved` 从 `set-discussion-resolved` 变为 `discussion-resolved:set`，`acme-tracker` 的 `assign_issue` 从 `assign-issue` 变为 `issue:assign`。样本里没有「复数 provider 词在结尾」的真实工具，规则 2 的例外不改变任何已有的规范写法；新增的合成样本 `other/notes.json` 覆盖它。
- 真实 server 里受影响的是：provider 名是复数、工具名以它结尾的 server（`close_todos`、`search_docs`），和名字里有上面八个动词的工具。它们都是**从叶子变为 `资源:动作`**，所以按叶子写法或原始名写的 `deny` 规则照常命中（[naming.md](../spec/naming.md#稳定性约定)）；按「叶子名」写的脚本（`via todos close`）要改成 `via todos todo:close`，原始名 `close_todos` 始终有效。`CHANGELOG.md` 逐条列出。
- 浏览视图（`-o json` 也是）在有同名叶子的资源下多一行，每次多约一行的 token；没有同名叶子时输出不变。
- 退出码与 `next:` 的格式不变；候选数仍至多 3 个。
- 动词表的保守性：新增的八个词里，`set`、`complete` 偶尔也作名词或形容词（`complete_*`），在样本里没有错拆；若以后出现反例，按[数据文件](../development/data-files.md#verbsjson)的流程撤回要等下一个小版本（补丁版本不得删除动词）。
