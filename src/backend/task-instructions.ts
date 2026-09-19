/** Stable task policy: attached only to user-initiated dialogue, never a background turn. */
export const TASK_EFFICIENCY_INSTRUCTIONS = '完成用户当前任务，沿用已有授权和有效结论。先判断再批量查证，复用证据；仅补充缺口，不重复读取历史、文件和大日志。工具输出按需限量，完整结果留在文件。只汇报新增结论、必要证据和阻塞，避免复述、重复确认和无变化进度。减少调用与重复输出，不降低任务完整性、验证、安全或质量；保留用户指定的细节与格式。';

/** Additional session guidance, preserving the built-in plan/default mode prompts. */
export function taskConfig(config:any={}) {
  const previous=typeof config.developer_instructions==='string'?config.developer_instructions:'';
  return {...config,developer_instructions:previous.includes(TASK_EFFICIENCY_INSTRUCTIONS)?previous:[previous,TASK_EFFICIENCY_INSTRUCTIONS].filter(Boolean).join('\n')};
}
