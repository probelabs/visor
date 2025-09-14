import { API, MockapiMethod } from "../mockapi/mockapi.types";
export declare class Mockapi {
    private apiSchema;
    private _mock;
    private allowUnmocked;
    constructor(apiSchema: string | API, allowUnmocked?: boolean);
    /**
     * Returns the request mocker functions generated from api schema
     */
    get mock(): MockapiMethod;
    /**
     * For each endpoint for each api it generates a request mocker function just like moctokit
     * @returns
     */
    private apiSchemaToMethod;
    private validateAPISchema;
}
