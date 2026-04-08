# Files Module

## 范围

该模块是 workspace 内文件管理 API 的草案，目标是支撑成熟 web 文件管理场景，而不是一次性暴露整棵目录树。

当前仅为接口设计草案，尚未表示服务端已经完成实现。

该模块包括：

- 按目录分页列出直接子项
- 读取单个文件内容
- 创建或覆盖单个文件
- 上传原始文件字节流
- 下载原始文件字节流
- 创建目录
- 删除文件或目录
- 重命名或移动文件/目录

暂不包括：

- 全 workspace 递归树一次性返回
- 批量复制 / 批量移动 / 批量删除
- workspace 内全文搜索
- 文件上传分片与断点续传
- 文件变更 watch / 推送

## 接口

### `GET /workspaces/{workspaceId}/entries`

用途：

- 读取某个目录下的直接子项
- 用于侧边树、表格视图、懒加载目录展开

查询参数：

- `path`
  - 目标目录路径，默认 `.` 表示 workspace 根目录
- `pageSize`
- `cursor`
- `sortBy`
  - `name | updatedAt | sizeBytes | type`
- `sortOrder`
  - `asc | desc`

返回：

- `workspaceId`
- `path`
- `items[]`
- `nextCursor`

约束：

- 只返回直接 children，不递归
- `path` 必须位于 workspace root 内
- 返回结果应稳定排序，便于 cursor 分页

### `GET /workspaces/{workspaceId}/files/content`

用途：

- 读取单个文件内容
- 支撑编辑器打开、预览和下载前的元数据探测

查询参数：

- `path`
- `encoding`
  - `utf8 | base64`
- `maxBytes`
  - 用于预览模式截断响应，避免一次返回超大文件

返回：

- `workspaceId`
- `path`
- `encoding`
- `content`
- `truncated`
- `sizeBytes`
- `mimeType`
- `etag`
- `updatedAt`
- `readOnly`

说明：

- 文本文件优先使用 `utf8`
- 二进制或未知编码文件可使用 `base64`
- `truncated=true` 表示调用方拿到的是预览结果，不是全量内容

### `PUT /workspaces/{workspaceId}/files/content`

用途：

- 创建文件
- 覆盖已有文件

请求体字段：

- `path`
- `content`
- `encoding`
  - `utf8 | base64`
- `overwrite`
- `ifMatch`

说明：

- `overwrite=false` 时，若目标已存在，应返回冲突错误
- `ifMatch` 用于乐观并发控制，避免前端覆盖他人更新
- 对已有文件，后续实现建议结合 `etag` 使用条件写入

### `POST /workspaces/{workspaceId}/directories`

用途：

- 创建目录

请求体字段：

- `path`
- `createParents`

说明：

- 默认为递归创建父目录
- 若目标已存在且为目录，可返回当前目录元数据或幂等成功

### `PUT /workspaces/{workspaceId}/files/upload`

用途：

- 通过原始请求体上传文件内容
- 更适合二进制文件和常规 web 文件上传入口

查询参数：

- `path`

请求体：

- `Content-Type: application/octet-stream`
- body 为原始字节流

说明：

- 该接口与 `PUT /files/content` 的区别在于不经过 JSON 包装
- 推荐用于图片、压缩包、二进制产物等上传场景

### `GET /workspaces/{workspaceId}/files/download`

用途：

- 下载某个文件的原始字节流

查询参数：

- `path`

返回：

- 原始文件字节流
- 推荐附带 `Content-Disposition`、`ETag`、`Last-Modified`

说明：

- 该接口更适合浏览器下载、对象预览和二进制客户端消费
- 若调用方要在编辑器内读取内容，仍优先使用 `GET /files/content`

### `DELETE /workspaces/{workspaceId}/entries`

用途：

- 删除单个文件
- 删除单个目录

查询参数：

- `path`
- `recursive`

说明：

- 删除非空目录时，要求显式传 `recursive=true`
- 是否允许删除 workspace 关键文件，可由宿主策略控制

### `PATCH /workspaces/{workspaceId}/entries/move`

用途：

- 重命名文件或目录
- 将条目移动到另一个目录

请求体字段：

- `sourcePath`
- `targetPath`
- `overwrite`

说明：

- 该接口既承担 rename，也承担 move
- 推荐在同一 workspace 内实现为单次原子操作

## 设计说明

### 为什么不用全量树

- workspace 文件很多时，全量树会让首屏和目录展开都变慢
- 前端通常只需要当前展开目录的直接 children
- 懒加载目录树更适合虚拟滚动、分页和局部刷新
- 服务端也更容易做权限校验、缓存和路径安全控制

### 为什么目录列表和文件内容拆开

- 目录列表高频、轻量，主要面向导航
- 文件内容低频、体积大，主要面向编辑与预览
- 将两者拆开后，列表接口不会被大文件拖慢

### 为什么删除与移动用 entry 抽象

- web 文件管理对“文件”和“目录”的操作入口通常高度相似
- 删除、重命名、移动对文件和目录都成立
- 用 `entry` 抽象可以减少重复接口数量

### 大目录建议

- 单目录默认按 `pageSize` 分页，不返回总量统计作为必需字段
- 默认按稳定键排序，避免目录变更时 offset 漂移
- 对于非常大的目录，优先 cursor，而不是 offset

### 后续可扩展项

- `POST /workspaces/{workspaceId}/entries/copy`
- `POST /workspaces/{workspaceId}/entries/delete-batch`
- `POST /workspaces/{workspaceId}/entries/move-batch`
- `GET /workspaces/{workspaceId}/search`
- 文件上传与下载专用通道
