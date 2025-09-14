import { Step } from "../act/act.type";
export declare class OutputParser {
    private output;
    private stepMatrix;
    private outputMatrix;
    private groupMatrix;
    private isPartOfGroup;
    constructor(output: string);
    /**
     * Parse the output produced by running act successfully. Produces an object
     * describing whether the job was successful or not and what was the output of the job
     * @returns
     */
    parseOutput(): Step[];
    /**
     * Check if the line indicates the start of a step. If it does then accordingly
     * update the bookkeeping variables
     * @param line
     */
    private parseRun;
    /**
     * Check if the line indicates that a step was successful. If it does then accordingly
     * update the bookkeeping variables
     * @param line
     */
    private parseSuccess;
    /**
     * Check if the line indicates that a step failed. If it does then accordingly
     * update the bookkeeping variables
     * @param line
     */
    private parseFailure;
    /**
     * Check if the line indicates the start of a group annotation. If it does then accordingly
     * update the bookkeeping variables
     * @param line
     */
    private parseStepOutput;
    /**
     * Check if the line indicates the end of a group annotation. If it does then accordingly
     * update the bookkeeping variables
     * @param line
     */
    private parseStartGroup;
    /**
     * Check if the line is an output line. If it does then accordingly
     * update the bookkeeping variables
     * @param line
     */
    private parseEndGroup;
    private resetOutputAndGroupMatrix;
}
