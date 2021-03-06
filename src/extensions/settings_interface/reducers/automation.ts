import { IReducerSpec } from '../../../types/IExtensionContext';

import * as actions from '../actions/automation';

import update from 'immutability-helper';

/**
 * reducer for changes to automation settings
 */
const automationReducer: IReducerSpec = {
  reducers: {
    [actions.setAutoDeployment as any]: (state, payload) =>
      update(state, { deploy: { $set: payload } }),
    [actions.setAutoEnable as any]: (state, payload) =>
      update(state, { enable: { $set: payload } }),
    [actions.setAutoStart as any]: (state, payload) =>
      update(state, { start: { $set: payload } }),
    [actions.setStartHidden as any]: (state, payload) =>
      update(state, { hide: { $set: payload } }),
  },
  defaults: {
    deploy: true,
    enable: false,
    start: false,
    hide: false,
  },
};

export default automationReducer;
