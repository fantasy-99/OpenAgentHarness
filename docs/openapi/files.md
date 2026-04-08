# Files Module

Workspace 文件管理 API，支撑 web 文件管理场景。当前为接口设计草案。

暂不包括：全 workspace 递归树、批量操作、全文搜索、分片上传、文件变更推送。

## 接口

### `GET /workspaces/{workspaceId}/entries`

读取目录直接子项。参数：`path`（默认 `.`）、`pageSize`、`cursor`、`sortBy`（name / updatedAt / sizeBytes / type）、`sortOrder`。只返回直接 children，不递归。

### `GET /workspaces/{workspaceId}/files/content`

读取文件内容。参数：`path`、`encoding`（utf8 / base64）、`maxBytes`（预览截断）。

返回：`content`、`truncated`、`sizeBytes`、`mimeType`、`etag`、`updatedAt`、`readOnly`。

### `PUT /workspaces/{workspaceId}/files/content`

创建或覆盖文件。字段：`path`、`content`、`encoding`、`overwrite`、`ifMatch`（乐观并发控制）。

### `POST /workspaces/{workspaceId}/directories`

创建目录。字段：`path`、`createParents`。已存在时幂等返回。

### `PUT /workspaces/{workspaceId}/files/upload`

原始字节流上传。参数：`path`。Body: `application/octet-stream`。适合二进制文件。

### `GET /workspaces/{workspaceId}/files/download`

下载原始字节流。参数：`path`。附带 `Content-Disposition`、`ETag`、`Last-Modified`。

### `DELETE /workspaces/{workspaceId}/entries`

删除文件或目录。参数：`path`、`recursive`（非空目录须 `true`）。

### `PATCH /workspaces/{workspaceId}/entries/move`

重命名或移动。字段：`sourcePath`、`targetPath`、`overwrite`。

## 设计说明

- **不用全量树：** 大 workspace 全量树慢，懒加载更适合虚拟滚动和分页
- **目录列表与文件内容分离：** 列表高频轻量，内容低频体积大
- **entry 抽象：** 删除、移动对文件和目录通用，减少重复接口
- **大目录：** 按 `pageSize` 分页，稳定键排序，优先 cursor 而非 offset
