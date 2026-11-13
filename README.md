# 作业看板拖放分派的浏览器自动化

本项目用于授权资料接入的单次查看与接收留存，使用 Node.js 22。来源协议见 `docs/source-contract.md`。本地演练服务只绑定回环地址，数据不含真实个人资料或账号。

## 安装与运行

依赖由 `package-lock.json` 固定。首次准备环境运行 `npm ci --ignore-scripts`，浏览器项目使用 Playwright 1.56.1 对应的 Chromium；浏览器及系统库在镜像准备阶段安装，不在业务命令中下载。

```sh
npm run build
npm test
npm run demo
npm run start
```

`npm run demo` 启动本地来源和接入服务，实际获取单次查看结果并写入临时接收记录，显示完整 JSON，随后关闭服务并清理临时目录。通常在十秒内结束。`npm start` 启动常驻服务，默认端口3000，可通过 PORT 与 DATA_DIR 修改监听端口和接收目录。设置 SOURCE_URL 可连接另一进程中已启动的本地来源；不设置时自动创建演练来源。恢复演练可先用 `npm run source` 在另一终端启动来源，记下输出地址，保持该进程运行，仅重启设置了 SOURCE_URL 的接入服务。

## 浏览器分派

`src/board.mjs` 是门户适配层，`src/dispatch.mjs` 负责计划、执行和恢复核对。所有变更都走页面正常动作：展开折叠泳道、滚动虚拟列表、HTML5 拖放、浏览器确认框、时段下拉与确认；不调用 `/state`，也不改写页面数据。

```sh
npm run dispatch -- preview plan.json
npm run dispatch -- run plan.json
npm run dispatch -- recover plan.json --previous state.json
```

计划格式：

```json
{
  "target": "team-b",
  "cards": [{"key": "V1-LOAD", "voyage": "V1"}, {"key": "V6-LOAD"}],
  "slots": {"V6-LOAD": "14:00-16:00"},
  "confirm": {"V1-LOAD": "cancel"},
  "zones": {"V3-LOAD": "placeholder"}
}
```

卡片按业务键（`key` + 航次 + 页面版本 + 当前泳道）核对，重名卡不会被标题混淆。预览输出可执行项、冲突项与依赖批次；执行按批次推进，单卡失败只阻断依赖它的后继。落点结果以页面 `#status` 与 `data-saved` 为准，最终归属由执行后的页面快照与恢复核对确认。每个动作依据都记录在输出的 `evidence` 中。

`npm run demo:dispatch` 在本地演练门户上运行重名卡、容量竞争、确认取消、前置失败、虚拟滚动与补选时段场景，并启动 `http://127.0.0.1/local-board` 看板展示各场景的计划、执行结果与逐动作页面证据。设置 `REPORT_DIR` 可保留 JSON 报告。

## 接口与模块

`GET /health` 查看状态，`GET /inspect` 查看来源，`GET /receive?key=sample` 保存单次接收，`GET /receipts/sample` 读取回执。相同key和相同内容可重复接收，不同内容拒绝覆盖。

`src/connector.mjs` 解释单次来源响应，`fixtures/source.mjs` 提供可重复启动的本地来源，`src/service.mjs` 组织访问入口，`src/store.mjs` 保存查看结果。`src/board.mjs` 读取并操作演练门户页面，`src/dispatch.mjs` 生成与执行分派计划，`src/report.mjs` 渲染本地演练看板。`test/connector.test.mjs` 验证协议原语和演练源，`test/dispatch.test.mjs` 验证业务键分派、容量、取消、依赖与恢复场景，`test/service.test.mjs` 验证服务与留存边界。

生产接入地址与凭据需由部署配置给出；演练客户端拒绝访问回环以外的地址。文档中的接口不向外提供任意目标代理。异常以明确错误响应返回，接收失败不覆盖原回执。
