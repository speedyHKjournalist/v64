# 异常交付与每核 shutdown

实现依据是 [Intel SDM Vol. 3A](https://cdrdv2-public.intel.com/868137/325462-089-sdm-vol-1-2abcd-3abcd-4.pdf) 的异常递进表（table 7-5）及 shutdown 规则。硬件中断的向量号不作为同步异常类别，选择子错误码保留外部事件 EXT 位。

`tests/smp/exception_lifecycle.mjs` 用真实 DIV/UD2/INT/IRET 指令覆盖 benign→#NP、contributory→#DF、contributory→#PF、#PF→#DF、#DF 再失败进入 shutdown；验证 #DF 错误码 0、无效 IRET 的选择子/存在/界限检查优先级、NMI 交付错误 EXT、描述符整长和栈帧超界。客户机错误不能触发宿主 panic。

主板策略：BSP shutdown 在 Wasm 返回安全点后复位全机，清编译结果及旧调度轮次；AP shutdown 不重启其他核，状态参与全机快照。普通 AP shutdown 可由 NMI 或 INIT 恢复，INIT 后等待 SIPI；NMI 内 shutdown 必须硬件复位。未实现 SMM，不能据此声称 SMI 验收。

最新 debug fixture 已通过；release 仍待最终构建重跑。旧快照缺省 shutdown=0。该门槛不替代真实 OS 整机重启压力，region 后端压力重启目前仍在排查。
