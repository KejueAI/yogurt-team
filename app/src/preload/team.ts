/** Yogurt Team's bridge, window.yogurtTeam, beside upstream's window.yogurt (one import line in preload/index.ts) */
import { contextBridge, ipcRenderer } from 'electron'
import type { YogurtTeamApi } from '../main/team/types'

const teamApi: YogurtTeamApi = {
  state: () => ipcRenderer.invoke('yogurtTeam:state'),
  setServerUrl: (url) => ipcRenderer.invoke('yogurtTeam:setServerUrl', url),
  signIn: () => ipcRenderer.invoke('yogurtTeam:signIn'),
  cancelSignIn: () => ipcRenderer.invoke('yogurtTeam:cancelSignIn'),
  signOut: () => ipcRenderer.invoke('yogurtTeam:signOut'),
  refresh: () => ipcRenderer.invoke('yogurtTeam:refresh'),
  openAdmin: () => ipcRenderer.invoke('yogurtTeam:openAdmin'),
  meeting: (id) => ipcRenderer.invoke('yogurtTeam:meeting', id),
  setPrivate: (id, on) => ipcRenderer.invoke('yogurtTeam:setPrivate', id, on),
  retry: (id) => ipcRenderer.invoke('yogurtTeam:retry', id),
  openFolder: (id) => ipcRenderer.invoke('yogurtTeam:openFolder', id),
  onChange: (cb) => {
    const on = () => cb()
    ipcRenderer.on('yogurtTeam:changed', on)
    return () => { ipcRenderer.removeListener('yogurtTeam:changed', on) }
  },
}
contextBridge.exposeInMainWorld('yogurtTeam', teamApi)
