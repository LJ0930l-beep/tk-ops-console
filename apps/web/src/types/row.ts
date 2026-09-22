/** el-table 插槽给出的 row 是动态字典（DefaultRow），处理函数按这个收口，别在模板里逐处断言 */
export type RowLike = Record<string, any>;
