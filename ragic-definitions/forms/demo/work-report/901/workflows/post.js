// 公開 Demo 的合成 workflow：示範儲存後、可重入的整合邊界。
var workOrder = param.getNewNode().getFieldValue("1001");
if (workOrder) {
  response.setMessage("Demo work report saved: " + workOrder);
}
